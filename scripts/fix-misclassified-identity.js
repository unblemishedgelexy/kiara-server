#!/usr/bin/env node
const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
(async function main(){
  try{
    const connect = require('../src/db/connect');
    await connect();
    const LongTerm = require('../src/models/LongTermMemory');
    const { decrypt } = require('../src/utils/crypto');

    const candidates = await LongTerm.find({ category: 'identity' }).lean();
    console.log('[FIX] identity candidates count', candidates.length);
    let fixed = 0;
    for (const doc of candidates) {
      try {
        const text = decrypt(doc.encryptedMemory || '');
        const lower = String(text).toLowerCase();
        if (lower.includes('build') || lower.includes('project') || lower.includes('working on')) {
          await LongTerm.findByIdAndUpdate(doc._id, { category: 'project', updatedAt: new Date() });
          console.log('[FIX] reclassified', String(doc._id), '-> project', 'preview:', text.slice(0,80));
          fixed++;
        }
      } catch (e) {
        console.warn('[FIX] decrypt error for', String(doc._id), e.message);
      }
    }

    console.log('[FIX] completed, fixed=', fixed);
    process.exit(0);
  }catch(e){
    console.error(e);
    process.exit(1);
  }
})();
