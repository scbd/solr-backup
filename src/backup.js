const config    = require('./config');
const winston   = require('./logger')(__filename);
const request   = require('superagent');
const AWS       = require('aws-sdk');
const fsp       = require('fs').promises;
const fs        = require('fs');
var zlib        = require('zlib');

const {Docker}  = require('node-docker-api');
const docker    = new Docker({ socketPath: '/var/run/docker.sock' });
const S3        = new AWS.S3({
                                accessKeyId     : config.AWS.accessKeyId,
                                secretAccessKey : config.AWS.secretAccessKey,
                                region          : 'us-east-1',
                                apiVersion      : '2006-03-01'
                            });
const s3UploadStream  = require('s3-upload-stream')(S3)

const sleep = (time)=> new Promise((resolve)=>setTimeout(resolve, time)); 


const getCollectionNames = (collections)=>{
    winston.debug('Getting collection list')

    let collectionNames = [];
    for (const collection in collections.status) {
        if (collections.status.hasOwnProperty(collection)) {
            const element = collections.status[collection];
            collectionNames.push(element.name)
        }
    }

    return collectionNames;


}

const backupCollection = async (container, collection, path, backupName)=>{

    winston.info(`Executing backup for collection ${collection}`)
    // Begin Backup

    const solrUrl           = `${config.SOLR_URL}/solr/${collection}/replication`;
    const backupUrl         = `${solrUrl}?command=backup&location=${path}&name=${backupName}&wt=json`;
    const backupDetailsUrl  = `${solrUrl}?command=details&wt=json`;
    
    const response = await execCurl(container, backupUrl);

    if(response.status != 'OK'){
        winston.error(`Solr backup failed for collection ${collection}`, response)
        return;
    }

    //Wait for backup to finish
    const backupStatusDetails = await backupStatus(container, backupDetailsUrl, backupName, 0);

    winston.debug('Collection backup finished');

    return `${path}/snapshot.${backupName}`;
}

const backupStatus = async (container, backupDetailsUrl, backupName, counter) => {

    const backupStatusDetails = await execCurl(container, backupDetailsUrl);
    winston.debug(`verifying backup status for ${backupName}`);

    // if(backupStatusDetails.status != 'OK'){
    //     // if(!backupStatusDetails.details || !backupStatusDetails.details.backup || !backupStatusDetails.details.backup.includes("success")){        
    //         winston.error(`Solr backup failed for collection ${backupName}`, backupStatusDetails)
    //         throw new Error(`Solr backup failed for collection ${backupName}`);
    //     }
    // }
    if(backupStatusDetails.details && backupStatusDetails.details.backup){
        if(backupStatusDetails.details.backup.includes(backupName))
            return backupStatusDetails;
    }

    if(counter < 20){
        await sleep(10000) // sleep for 10 seconds
        const res = (await backupStatus(container, backupDetailsUrl, backupName, counter+1));
        return res;
    }
};

const promisifyStream = (stream, returnOutput) => new Promise((resolve, reject) => {
    let output;
    stream.on('data', data => {
        output += data.toString();
    })
    stream.on('end', ()=>resolve(output))
    stream.on('error', reject)
});


const uploadToS3 = (name, filePath) =>{

    winston.debug('Uploading file to S3');

    // const stream     = require('stream');
    // let   streamPass = new stream.PassThrough();
    const bucket     = config.S3_BUCKET;
    const key        = `${config.S3_BUCKET_FOLDER}/${name}`;

    let s3Options =  {
        Bucket      : bucket, 
        Key         : key,
        // Body        : streamPass
    };

    const s3Stream = s3UploadStream.upload(s3Options);//.promise();

    // Handle errors.
    s3Stream.on('error', function (error) {
        winston.debug('S3 Upload error', error);
    });
    s3Stream.on('part', function (details) {
        winston.debug('S3 Upload part', details);
    });
    s3Stream.on('uploaded', function (details) {
        winston.debug('S3 Upload uploaded', details);
    });

    return s3Stream;
//     return { s3Promise
//         s3Pipe:streamPass, 
//         s3Promise 
//     };

}

const execCurl = async (container, url)=>{
    
    winston.debug(`Executing curl for ${url}`);
    const bashContainer = await container.exec.create({
        AttachStdout: true,
        AttachStderr: true,
        Cmd: [ 'curl', url ]
    });

    const stream = await bashContainer.start({ Detach: false });

    let output = await promisifyStream(stream);

    output = output.substring(output.indexOf('{'), output.lastIndexOf('}')+1)
    
    winston.debug(`Curl execution finished`);

    return JSON.parse(output)

}

const dockerExec = async(container, cmd)=>{
    winston.debug(`executing cmd: ${cmd}`)
    const bashContainer = await container.exec.create({
        AttachStdout: true,
        AttachStderr: true,
        Cmd:  cmd
    });

    const stream = await bashContainer.start({ Detach: false });
    let output = await promisifyStream(stream);
    winston.debug(output)
}

const cleanup = async (container, solrBackupDir, localeBackupDir)=>{
    winston.debug(`Begin cleanup`);
    
    await dockerExec(container, ['rm', '-rf', `${solrBackupDir}`]);

    await rmDir(localeBackupDir, true);
    //rmdir(localeBackupDir, { recursive: true })

    winston.debug(`Finished cleanup`);
}
const rmDir = async function(dir, rmSelf) {
    var files;
    rmSelf = (rmSelf === undefined) ? true : rmSelf;
    dir = dir + "/";
    try { 
        files = await fsp.readdir(dir); 
    } 
    catch (e) { 
        winston.info("!Oops, directory not exist."); 
        return; 
    }
    if (files.length > 0) {
        for(let i=0; i< files.length; i++) {
            const pathStat = await fsp.stat(dir + files[i]);
            if (pathStat.isDirectory()) {
                await rmDir(dir + files[i]);
            } else {
                await fsp.unlink(dir + files[i]);
            }
        };
    }
    if (rmSelf) {
        await fsp.rmdir(dir);
    }
}

const toRegExp = (obj)=> {
    if (!obj) {
      return null
    }
  
    if (obj instanceof RegExp) {
      return obj
    }
  
    return new RegExp(obj)
}

const backup = async ()=>{

    try{
        const containerName  = toRegExp(config.SOLR_CONTAINER_NAME);
        const containerImage = toRegExp(config.SOLR_CONTAINER_IMAGE);

        winston.info(`Starting Solr backup `);
        const list = await docker.container.list();
       
        const solrContainer = list.find(e=> {
            
            //skip self
            if(/scbd\:solr\-backup/.test(e.data.Image)) return false;

            if(containerName)
                return e.data.Names.find(name=>name.match(containerName));

            if(containerImage)    
                return e.data.Image.match(containerImage);

            return /solr/.test(e.data.Image);

        })

        if(!solrContainer){
            winston.error('No Sorl container found, skipping backup');
            return;
        }

        const collections      = await execCurl(solrContainer, `${config.SOLR_URL}/solr/admin/cores?wt=json`);
        const collectionNames  = getCollectionNames(collections);
        // bashContainer.kill();

        if(collectionNames.length>0){

            const snapshotName          = `${new Date().getTime()}`;
            const localBackupFileExt    = `tar.gz`;
            const localBackupFolder     = './backup-files';
            const solrBackupFolder      = config.SOLR_BACKUP_FOLDER;

            try{
                winston.debug('Initial cleanup')
                //Delete folders incase they were left from previous run
                await cleanup(solrContainer, solrBackupFolder, localBackupFolder);
            }
            catch(e){}

            let backupFolder;
            try{
                backupFolder = await fsp.stat(localBackupFolder);
            }
            catch(e){}

            if(!backupFolder || !backupFolder.isDirectory())
                await fsp.mkdir(localBackupFolder)       

            winston.info(`Collections to backup: ${collectionNames.length}`);

            winston.debug('create backup folder inside solr container');
                try{
                    await dockerExec(solrContainer, ['mkdir', `${solrBackupFolder}`]);
                }
                catch(e){
                    winston.info(e)
                }

            for (let index = 0; index < collectionNames.length; index++) {

                try{
                    

                    const collectionSnapshot    = `${collectionNames[index]}_${snapshotName}`;
                    const solrBackupPath        = await backupCollection(solrContainer, collectionNames[index], solrBackupFolder, collectionSnapshot);
                    
                    const localBackupFileName   = `${solrBackupPath.replace(solrBackupFolder+'/', '')}.${localBackupFileExt}`;
                    const localBackupFilePath   = `${localBackupFolder}/${localBackupFileName}`;

                    if(solrBackupPath){
                        winston.debug(`Reading backup from container`);

                        const s3Pipe = uploadToS3(localBackupFileName, localBackupFilePath);//{ s3Pipe, s3Promise }
                        const stream = await solrContainer.fs.get({path:solrBackupPath});
                        const gz     = zlib.createGzip();

                        stream.pipe(gz).pipe(s3Pipe);
                        await promisifyStream(stream);

                        // await s3Promise;
                        winston.debug('S3 upload finished');

                        winston.debug(`Finished backup for collection ${collectionNames[index]}`)
                    }
                }
                catch(e){
                    winston.error(`Error occurred while taking collection backup`, e);
                }
            }

            try{
                winston.debug('Final cleanup')
                await cleanup(solrContainer, solrBackupFolder, localBackupFolder);
            }
            catch(e){}

            winston.info(`Finished Solr backup process`);
        }
    }
    catch(e){
        winston.error(`Error occurred while taking SOLR backup`, e);
    }
}

module.exports = backup;
