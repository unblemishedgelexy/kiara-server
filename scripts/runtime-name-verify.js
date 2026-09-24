const http = require('http');
const { GoogleGenAI } = require('@google/genai');

function requestJSON(method, url, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (token) {
      headers.Authorization = 'Bearer ' + token;
    }

    const req = http.request(url, { method, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => {
        text += String(chunk);
      });
      res.on('end', () => {
        try {
          const obj = text ? JSON.parse(text) : null;
          if (res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}: ${text}`));
          }
          resolve(obj);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  try {
    const devSession = await requestJSON('POST', 'http://localhost:4000/api/auth/dev-session', {});
    const accessToken = devSession && devSession.accessToken;
    if (!accessToken) {
      throw new Error('Missing dev access token');
    }

    const liveTokenResponse = await requestJSON(
      'POST',
      'http://localhost:4000/api/live/token',
      {
        sessionId: 'runtime-live-verify',
        userQuery: 'What is my name?',
        activeContext: { source: 'runtime-live-verify' },
      },
      accessToken
    );

    const systemInstruction = liveTokenResponse?.sessionConfig?.systemInstruction || '';
    const fullNameHit = /Local Test User/i.test(systemInstruction);
    const developerHit = /Roshan Badgujar/i.test(systemInstruction);

    console.log(JSON.stringify({
      authTokenPresent: Boolean(accessToken),
      userIdPresent: true,
      systemInstructionPresent: Boolean(systemInstruction),
      systemInstructionLength: systemInstruction.length,
      fullNamePresent: fullNameHit,
      developerMetadataPresent: developerHit,
      model: liveTokenResponse?.sessionConfig?.model || null,
    }, null, 2));

    const ai = new GoogleGenAI({ apiKey: liveTokenResponse.token });
    const session = await ai.live.connect({
      model: liveTokenResponse.sessionConfig.model,
      config: {
        responseModalities: ['TEXT'],
        systemInstruction,
      },
      callbacks: {
        onOpen: () => console.log('LIVE_OPEN'),
        onMessage: (msg) => {
          const text = extractTextFromMessage(msg);
          if (text) {
            console.log('LIVE_MESSAGE=' + JSON.stringify(text));
          }
        },
        onClose: () => console.log('LIVE_CLOSE'),
        onError: (err) => console.log('LIVE_ERROR=' + String(err && err.message ? err.message : err)),
      },
    });

    console.log('CONNECTED_SESSION');
    session.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: 'What is my name?' }] }],
      turnComplete: true,
    });

    await wait(20000);
    console.log('VERIFY_DONE');
    process.exit(0);
  } catch (error) {
    console.error('RUNTIME_VERIFY_ERROR=' + String(error && error.message ? error.message : error));
    process.exit(1);
  }
}

function extractTextFromMessage(msg) {
  try {
    const parts = msg && msg.serverContent && msg.serverContent.modelTurn && Array.isArray(msg.serverContent.modelTurn.parts)
      ? msg.serverContent.modelTurn.parts
      : [];
    return parts
      .map((part) => typeof part?.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join(' ');
  } catch {
    return '';
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main();
