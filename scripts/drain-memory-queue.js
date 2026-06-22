#!/usr/bin/env node
const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
(async function main(){
  try{
    const connect = require('../src/db/connect');
    await connect();
    const { countQueueStatus } = require('../src/services/memory/memoryJobService');
    const { processMemoryJobs } = require('../src/services/workers/memoryWorkerService');
    let rounds = 0;
    while(true){
      const status = await countQueueStatus();
      console.log('[DRAIN] queueStatus', status);
      if(!status || status.pending === 0) break;
      const res = await processMemoryJobs(50).catch((e)=>{console.error('processMemoryJobs error',e); return {processed:0};});
      console.log('[DRAIN] processed', res.processed);
      rounds++;
      if(rounds > 200) { console.warn('[DRAIN] safety stop after',rounds); break; }
      await new Promise(r=>setTimeout(r, 200));
    }
    console.log('[DRAIN] finished');
    process.exit(0);
  }catch(e){
    console.error(e);
    process.exit(1);
  }
})();
