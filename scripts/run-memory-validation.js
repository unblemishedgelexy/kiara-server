#!/usr/bin/env node
const { runValidation } = require('../src/services/memory/validation/validationRunner');

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scripts/run-memory-validation.js <userId> [--seed] [--seedMessage="..."] [--seedResponse="..."]');
    process.exit(2);
  }
  const userId = args[0];
  const seed = args.includes('--seed');
  const seedMessageArg = args.find(a => a.startsWith('--seedMessage='));
  const seedResponseArg = args.find(a => a.startsWith('--seedResponse='));
  const seedMessage = seedMessageArg ? seedMessageArg.split('=')[1] : '';
  const seedResponse = seedResponseArg ? seedResponseArg.split('=')[1] : '';

  try {
    const result = await runValidation({ userId, seed, seedMessage, seedResponse });
    // Print formatted report
    console.log('\n===================================');
    console.log('KIARA MEMORY VALIDATION REPORT');
    console.log('===================================\n');
    for (const r of result.report) {
      console.log(r.stage);
      console.log(r.pass ? 'PASS' : 'FAIL');
      if (!r.pass) {
        if (r.error) {
          console.log('File: <runtime>');
          console.log('Function: <check>');
          console.log('Reason:', r.error && (r.error.message || r.error));
          console.log('Recommended Fix: Check logs and service availability');
        }
      }
      console.log('');
    }
    console.log('Overall', result.overall + '%');
    process.exit(0);
  } catch (e) {
    console.error('Validation runner failed:', e);
    process.exit(1);
  }
}

main();
