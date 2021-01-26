const config = {
  S3_BUCKET               : process.env.S3_BUCKET                 || 'scbd-backups',
  S3_BUCKET_FOLDER        : process.env.S3_BUCKET_FOLDER          || 'solr/development',
  SOLR_URL                : process.env.SOLR_URL                  || 'http://localhost:8983',
  SOLR_CONTAINER_NAME     : process.env.SOLR_CONTAINER_NAME   ,
  SOLR_CONTAINER_IMAGE    : process.env.SOLR_CONTAINER_IMAGE  ,
  SOLR_BACKUP_FOLDER      : process.env.SOLR_BACKUP_FOLDER        || '/var/solr/data/backups',

  NODE_ENV        : process.env.NODE_ENV,
  DEBUG_MODE      : process.env.DEBUG_MODE === 'true',
  LOG_LEVEL       : process.env.LOG_LEVEL || (process.env.DEBUG_MODE === 'true' ? 'debug':'info'),
  AWS             : {},

  CRON_TIME       : process.env.CRON_TIME || '* */6 * * *',
};

try{

  let configFile = process.env.CONFIG_FILE || '/run/secrets/config.json';

  if(configFile){
    config.AWS = require(configFile).awsAccessKeys.global;
  }
}
catch(e){}

module.exports = config;
