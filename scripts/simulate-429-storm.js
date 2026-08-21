const path = require('path');
// load server environment
process.env.NODE_ENV = 'test';
require('../src/app');

const gemini = require('../src/services/live/geminiService');

async function simulateBackground429Storm() {
  console.log('Starting 429-storm simulation against background endpoints...');

  // Fire many background generateText calls that will be treated as non-live
  const attempts = 20;
  const promises = [];

  for (let i = 0; i < attempts; i++) {
    promises.push(
      gemini.generateText({
        prompt: `Test prompt ${i}`,
        model: process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash',
        userId: `test-user-${i}`,
        sessionId: `test-session-${i}`,
      }).then(
        (res) => ({ ok: true, res }),
        (err) => ({ ok: false, err: err instanceof Error ? err.message : String(err) })
      )
    );
  }

  const results = await Promise.all(promises);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`Background calls completed. failures=${failed}/${attempts}`);

  // Now ensure createLiveEphemeralToken still works
  try {
    const token = await gemini.createLiveEphemeralToken('simulator');
    console.log('createLiveEphemeralToken succeeded:', !!token && !!token.token);
  } catch (err) {
    console.error('createLiveEphemeralToken FAILED:', err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
  }
}

simulateBackground429Storm().then(() => process.exit()).catch((err) => { console.error(err); process.exit(1); });
