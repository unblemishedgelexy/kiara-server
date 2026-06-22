#!/usr/bin/env node
const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
(async function(){
  try{
    const connect = require('../src/db/connect');
    await connect();
    const jobService = require('../src/services/memory/memoryJobService');
    const LongTerm = require('../src/models/LongTermMemory');
    const { decrypt } = require('../src/utils/crypto');
    const mps = require('../src/services/memory/memoryProfileService');

    const status = await jobService.countQueueStatus();
    console.log('queueStatus', status);

    const user = 'cert-user-0001';
    const docs = await LongTerm.find({ userId: user }).lean();
    console.log('ltm count', docs.length);
    for (let i = 0; i < docs.length; i++) {
      try {
        console.log(i, docs[i].category, decrypt(docs[i].encryptedMemory).slice(0,200));
      } catch (e) {
        console.warn('decrypt err', String(docs[i]._id), e.message);
      }
    }

    await mps.rebuildMemoryProfile(user);
    const p = await mps.getMemoryProfile(user);
    console.log('[PROFILE] identitySummary=', JSON.stringify(p && p.identitySummary));
    process.exit(0);
  }catch(e){
    console.error(e);
    process.exit(1);
  }
})();
