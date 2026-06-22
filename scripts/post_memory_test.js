const fetch = global.fetch || require('node-fetch');
const { generateAccessToken } = require('../src/services/auth/tokenService');
const { env } = require('../src/config/env');

async function run() {
  const userId = process.argv[2] || 'test-user-1';
  const text = process.argv[3] || 'My best friend is Aman.';

  const token = generateAccessToken({ sub: userId });

  const res = await fetch(`http://localhost:${env.port || 4000}/api/memory/process`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ text, role: 'user' }),
  });

  const data = await res.json().catch(() => null);
  console.log('Status', res.status);
  console.log('Response', data);
}

run().catch((err) => {
  console.error('Error posting memory:', err);
  process.exit(1);
});
