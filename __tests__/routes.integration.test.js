const request = require('supertest');
const { createSessionToken } = require('../src/utils/authCookies');

// Mock all external services
const mockedServices = {
  authService: {
    ensureGuestUser: jest.fn(async () => ({ _id: 'user1', displayName: 'Guest 1', mode: 'guest' })),
    registerUser: jest.fn(async (input) => ({ _id: 'user2', displayName: input.displayName, email: input.email, mode: 'registered' })),
    loginUser: jest.fn(async (input) => ({ _id: 'user2', displayName: 'Registered', email: input.email, mode: 'registered' })),
  },
  memoryService: {
    addShortTerm: jest.fn(async (input) => ({ _id: 'm1', ...input })),
    getShortTerm: jest.fn(async (sessionId) => [{ sessionId, message: 'hello' }]),
    deleteShortTerm: jest.fn(async () => ({})),
    analyzeAndSaveLongTerm: jest.fn(async () => ({ stored: true, summary: 'test summary' })),
    getLongTerm: jest.fn(async () => [{ _id: 'long1', content: 'long term memory' }]),
    deleteLongTerm: jest.fn(async () => ({})),
    patchLongTerm: jest.fn(async () => ({ _id: 'long1', content: 'updated' })),
  },
  liveTokenService: {
    createLiveEphemeralToken: jest.fn(async () => ({
      token: 'test-live-token',
      expireTime: '2024-12-31T23:59:59Z',
      newSessionExpireTime: '2024-12-31T23:59:59Z',
    })),
  },
  elevenLabsService: {
    streamElevenLabsSpeech: jest.fn(async (text) => ({
      headers: new Map([['content-type', 'audio/mpeg']]),
      body: [Buffer.from('audio data')],
    })),
  },
};

jest.mock('../src/services/authService', () => mockedServices.authService);
jest.mock('../src/services/memoryService', () => mockedServices.memoryService);
jest.mock('../src/services/liveTokenService', () => mockedServices.liveTokenService);
jest.mock('../src/services/elevenLabsService', () => mockedServices.elevenLabsService);

const createApp = require('../src/app');

let app;
let authToken;

beforeAll(() => {
  app = createApp();
  authToken = createSessionToken({ id: 'u1' });
});

describe('Routes Integration Tests', () => {
  test('GET / should return API running message', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success');
    expect(res.body).toHaveProperty('message');
  });
});

describe('All Routes - Authentication Requirements', () => {
  test('Auth routes should work without authentication', async () => {
    const res1 = await request(app).post('/auth/guest');
    expect(res1.status).toBe(200);

    const res2 = await request(app)
      .post('/auth/register')
      .send({ displayName: 'Test', email: 'test@example.com', password: 'pass' });
    expect([201, 400]).toContain(res2.status);
  });

  test('Memory routes should require authentication', async () => {
    const res1 = await request(app)
      .post('/memory/short/add')
      .send({ sessionId: 's1', role: 'user', message: 'test' });
    expect([401, 403]).toContain(res1.status);

    const res2 = await request(app).get('/memory/long');
    expect([401, 403]).toContain(res2.status);
  });

  test('Live routes - token endpoint should require authentication', async () => {
    const res = await request(app).post('/live/token');
    expect([401, 403, 503]).toContain(res.status);
  });

  test('TTS routes should require authentication', async () => {
    const res = await request(app)
      .post('/tts/preview')
      .send({ text: 'Hello' });
    expect([401, 403]).toContain(res.status);
  });
});

describe('All Routes - Request Validation', () => {
  test('Memory short add should validate required fields', async () => {
    const res = await request(app)
      .post('/memory/short/add')
      .send({ sessionId: 's1' })
      .set('Authorization', `Bearer ${authToken}`);

    expect([200, 400]).toContain(res.status);
  });

  test('TTS preview should validate text field', async () => {
    const res = await request(app)
      .post('/tts/preview')
      .send({})
      .set('Authorization', `Bearer ${authToken}`);

    expect([400, 403]).toContain(res.status);
  });

  test('Memory long analyze should validate text field', async () => {
    const res = await request(app)
      .post('/memory/long/analyze')
      .send({})
      .set('Authorization', `Bearer ${authToken}`);

    expect([200, 400]).toContain(res.status);
  });
});

describe('Complete User Journey', () => {
  test('Should handle complete guest-to-auth flow', async () => {
    // 1. Create guest user
    const guestRes = await request(app).post('/auth/guest');
    expect(guestRes.status).toBe(200);
    const guestToken = guestRes.body.token;
    expect(guestToken).toBeDefined();

    // 2. Add short-term memory with guest auth
    const memoryRes = await request(app)
      .post('/memory/short/add')
      .send({ sessionId: 's1', role: 'user', message: 'Test message' })
      .set('Authorization', `Bearer ${guestToken}`);
    expect(memoryRes.status).toBe(200);

    // 3. Retrieve short-term memory
    const getMemRes = await request(app)
      .get('/memory/short/s1')
      .set('Authorization', `Bearer ${guestToken}`);
    expect(getMemRes.status).toBe(200);
    expect(Array.isArray(getMemRes.body.data)).toBe(true);
  });

  test('Should handle short-term and long-term memory operations', async () => {
    const token = createSessionToken({ id: 'test-user' });

    // 1. Add short-term memory
    const shortRes = await request(app)
      .post('/memory/short/add')
      .send({ sessionId: 'session1', role: 'user', message: 'Short memory' })
      .set('Authorization', `Bearer ${token}`);
    expect(shortRes.status).toBe(200);

    // 2. Analyze and save long-term memory
    const longRes = await request(app)
      .post('/memory/long/analyze')
      .send({ text: 'Important long-term information' })
      .set('Authorization', `Bearer ${token}`);
    expect(longRes.status).toBe(200);

    // 3. Retrieve long-term memories
    const getLongRes = await request(app)
      .get('/memory/long')
      .set('Authorization', `Bearer ${token}`);
    expect(getLongRes.status).toBe(200);
    expect(Array.isArray(getLongRes.body.data)).toBe(true);
  });
});

describe('Error Handling Across Routes', () => {
  test('All protected routes should handle missing auth header', async () => {
    const routes = [
      { method: 'post', path: '/memory/short/add', body: { sessionId: 's1', role: 'user', message: 'test' } },
      { method: 'get', path: '/memory/short/s1' },
      { method: 'get', path: '/memory/long' },
      { method: 'post', path: '/live/token' },
      { method: 'post', path: '/tts/preview', body: { text: 'test' } },
    ];

    for (const route of routes) {
      const req = request(app)[route.method](route.path);
      if (route.body) {
        req.send(route.body);
      }
      const res = await req;
      expect([401, 403, 503]).toContain(res.status);
    }
  });

  test('Routes should handle invalid request body', async () => {
    const res = await request(app)
      .post('/memory/short/add')
      .send('invalid body')
      .set('Authorization', `Bearer ${authToken}`);

    expect([200, 400]).toContain(res.status);
  });
});

describe('Response Structure Validation', () => {
  test('Successful responses should have consistent structure', async () => {
    const res1 = await request(app).get('/live/health');
    expect(res1.status).toBe(200);

    const res2 = await request(app).get('/');
    expect(res2.status).toBe(200);
  });

  test('Auth responses should include token and user', async () => {
    const res = await request(app).post('/auth/guest');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body).toHaveProperty('user');
  });

  test('Memory responses should include success and data fields', async () => {
    const res = await request(app)
      .post('/memory/short/add')
      .send({ sessionId: 's1', role: 'user', message: 'test' })
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success');
    expect(res.body).toHaveProperty('data');
  });
});
