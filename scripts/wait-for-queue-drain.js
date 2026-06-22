#!/usr/bin/env node
const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
(async ()=>{
  try{
    const connect = require('../src/db/connect');
    await connect();
    const jobService = require('../src/services/memory/memoryJobService');
    const maxChecks = 180; // ~6 minutes
    let checks = 0;
    while(checks < maxChecks){
      const s = await jobService.countQueueStatus();
      console.log('[POLL] status', s);
      if(s.pending === 0 && s.processing === 0){
        console.log('[POLL] queue drained');
        process.exit(0);
      }
      checks++;
      await new Promise(r=>setTimeout(r, 2000));
    }
    console.warn('[POLL] timeout waiting for drain');
    process.exit(2);
  }catch(e){
    console.error(e); process.exit(1);
  }
})();
