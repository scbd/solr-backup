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

## Testing
Requires Node `^22.23.4 || ^24.22.1 || >=26.12.1` (see `engines` in `package.json`).

```
npm test
```

Without extra setup this runs the Node version and scheduler checks; the backup cycle tests are skipped.
To also run a full backup cycle, start a throwaway Solr 8 container with a core and a local S3 fake
(never point the tests at a real Solr or S3), then run the tests inside the image with the Docker socket mounted:

```
docker network create solr-backup-test
docker run -d --name solr-backup-test-solr --network solr-backup-test solr:8 solr-precreate testcore
docker run -d --name solr-backup-test-s3   --network solr-backup-test adobe/s3mock
docker build -t solr-backup:test .
docker run --rm --network solr-backup-test \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e TEST_S3_ENDPOINT=http://solr-backup-test-s3:9090 \
  -e 'SOLR_CONTAINER_NAME=^/solr-backup-test-solr$' \
  solr-backup:test npm test
```

`TEST_SOLR_CORES` (comma separated, default `testcore`) lists the cores expected in the backup.
`test/helpers/s3-local.js` points the AWS SDK at `TEST_S3_ENDPOINT` and `test/fixtures/config.json` holds dummy keys.
