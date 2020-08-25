const config  = require('./config');
const winston = require('./logger')(__filename);
const request = require('superagent');
const AWS     = require('aws-sdk');
const fsp     = require('fs').promises;
const fs      = require('fs');

const {Docker} = require('node-docker-api');

const docker   = new Docker({ socketPath: '/var/run/docker.sock' });

let S3 = new AWS.S3({
    accessKeyId     : config.AWS.accessKeyId,
    secretAccessKey : config.AWS.secretAccessKey,
    region          : 'us-east-1',
    apiVersion      : '2006-03-01'
});

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

    const url = `${config.SOLR_URL}/solr/${collection}/replication?command=backup&location=${path}&name=${backupName}`
    const response = await execCurl(container, url);

    if(response.status != 'OK'){
        winston.error(`Solr backup failed for collection ${collection}`, response)
        return;
    }

    winston.debug('Collection backup finished');

    return `${path}/snapshot.${backupName}`;
}

const promisifyStream = (stream, returnOutput) => new Promise((resolve, reject) => {
    let output;
    stream.on('data', data => {
        output += data.toString();
    })
    stream.on('end', ()=>resolve(output))
    stream.on('error', reject)
});


const uploadToS3 = async (name, filePath) =>{

    winston.debug('Uploading file to S3');

    const bucket =  config.S3_BUCKET;
    const key = `${config.S3_BUCKET_FOLDER}/${name}`;

    const fileBody = await fsp.readFile(`./${filePath}`);

    let s3Options =  {
        Bucket      : bucket, 
        Key         : key,
        Body        : fileBody
    };

    let s3File = await S3.putObject(s3Options).promise();

    winston.debug('S3 upload finished');
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


const cleanup = async (container, containerPath, localeFile)=>{
    winston.debug(`Begin cleanup`);

    const bashContainer = await container.exec.create({
        AttachStdout: true,
        AttachStderr: true,
        Cmd: [ 'rm -rf', containerPath ]
    });

    await bashContainer.start({ Detach: false });

    await fsp.unlink(localeFile)

    winston.debug(`Finished cleanup`);
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

        const collections      = await execCurl(solrContainer, `${config.SOLR_URL}/solr/admin/cores`);
        const collectionNames  = getCollectionNames(collections);
        // bashContainer.kill();

        if(collectionNames.length>0){

            const snapshotName  = `${new Date().getTime()}`;
            const fileName      = `${snapshotName}.tar`;
            const newFileFolder = './backup-files'
            
            let backupFolder;
            try{
                backupFolder = await fsp.stat(newFileFolder);
            }
            catch(e){}

            if(!backupFolder || !backupFolder.isDirectory())
                await fsp.mkdir(newFileFolder)       

            winston.info(`Collections to backup: ${collectionNames.length}`);

            for (let index = 0; index < collectionNames.length; index++) {

                try{
                    const backupPath = await backupCollection(solrContainer, collectionNames[index], '/tmp', `${collectionNames[index]}_${snapshotName}`);

                    const newFilePath = `${newFileFolder}/${fileName}`;

                    if(backupPath){
                        winston.debug(`Reading backup from container`);
                        const stream = await solrContainer.fs.get({path:backupPath});

                        const file = fs.createWriteStream(newFilePath);
                        stream.pipe(file);

                        await promisifyStream(stream);

                        await uploadToS3(fileName, newFilePath);

                        await cleanup(solrContainer, backupPath, newFilePath);
                    }
                }
                catch(e){
                    winston.error(`Error occurred while taking collection backup`, e);
                }
            }
            winston.info(`Finished Solr backup process`);
        }
    }
    catch(e){
        winston.error(`Error occurred while taking SOLR backup`, e);
    }
}

module.exports = backup;