#!/usr/bin/env node
const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
(async ()=>{
  try{
    const connect = require('../src/db/connect');
    await connect();
    const jobWorker = require('../src/services/workers/memoryWorkerService');
    const jobService = require('../src/services/memory/memoryJobService');

    const concurrency = 6; // number of parallel workers
    const batchSize = 100; // jobs per worker invocation
    const maxRounds = 200;
    for (let round = 0; round < maxRounds; round++){
      const status = await jobService.countQueueStatus();
      console.log('[FAST DRAIN] round', round, 'status', status);
      if(status.pending === 0 && status.processing === 0) {
        console.log('[FAST DRAIN] drained');
        process.exit(0);
      }
      const workers = [];
      for (let i=0;i<concurrency;i++){
        workers.push(jobWorker.processMemoryJobs(batchSize).catch(e=>{console.warn('[FAST DRAIN] worker err',e.message);return {processed:0};}));
      }
      const results = await Promise.all(workers);
      const total = results.reduce((s,r)=>s+(r && r.processed? r.processed:0),0);
      console.log('[FAST DRAIN] processed this round', total);
      if(total===0){
        // small sleep and retry
        await new Promise(r=>setTimeout(r,500));
      }
    }
    console.warn('[FAST DRAIN] max rounds reached');
    process.exit(2);
  }catch(e){console.error(e);process.exit(1);} 
})();
