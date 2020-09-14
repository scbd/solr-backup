const config     = require('./config');
const winston    = require('./logger')(__filename);
const backupSolr = require('./backup');
const CronJob    = require('cron').CronJob;

try{
  let job
  
  const onTick = async ()=> {
    try{
      winston.info('************BEGIN*************');

      await backupSolr()

      winston.info('*************END**************');

      showNextSchedule();
    }
    catch(e){
      winston.error(e);
    }

  }

  const showNextSchedule = ()=>{
    winston.info(`Next Schedule ${job.nextDate()}`)
  }

  if(process.env.LOCAL_ENV == 'true'){
      (async ()=>await backupSolr())()
  }
  else{
    job = new CronJob(config.CRON_TIME, onTick);
    showNextSchedule();
    job.start();
  }
}
catch(e){
  winston.error(e);
}

function closeServer(signal) {
  winston.error(`${signal} received`);
  process.exit(0);
}

process.on('SIGTERM', closeServer.bind(this, 'SIGTERM'));
process.on('SIGINT', closeServer.bind(this, 'SIGINT(Ctrl-C)'));

