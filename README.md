# docker-solr-backup

SOLR backup solution for Solr instances running inside docker

## Docker Example Build
```
docker build -t scbd/solr-backup:test .
```

## Docker Example Run
```
docker run -it  \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$(pwd)"/config.json://run/secrets/config.json \
  -e SOLR_CONTAINER_NAME="solr-container-name" \
  scbd/solr-backup:test
```

## Script Help
```
Docker solr backup

Performs a backup of every solr collection every 6 hours. The script uses Docker API to find a docker solr container and backup all available solr collections
All successful backups are uploaded AWS S3.


ENV variables:
    --S3_BUCKET                    S3 Bucket where the backup will be uploaded    
    --S3_BUCKET_FOLDER             S3 Folder to store the backup under the S3 Bucket    
    --SOLR_URL                     Solr URL    
    --SOLR_CONTAINER_NAME          Solr container name for backup(can be a Regex)    
    --SOLR_CONTAINER_IMAGE         Solr container image for backup(can be a Regex)
    --CONFIG_FILE                  AWS Secrets file eg. {
                                                          awsAccessKeys : {
                                                            global : {
                                                                accessKeyId     :"*******",
                                                                secretAccessKey :"*******"
                                                            }
                                                            
                                                        }  
```
