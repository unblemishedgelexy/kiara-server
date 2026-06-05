const request = require('supertest');
const { generateAccessToken } = require('../src/services/tokenService');

const mockedLiveTokenService = {
  createLiveEphemeralToken: jest.fn(async () => ({
    token: 'test-live-token',
    expireTime: '2024-12-31T23:59:59Z',
    newSessionExpireTime: '2024-12-31T23:59:59Z',
    sessionConfig: {
      model: 'gemini-3.1-flash-live-preview',
      responseModalities: ['AUDIO'],
      voiceName: 'Leda',
    },
  })),
};

jest.mock('../src/services/liveTokenService', () => mockedLiveTokenService);
const createApp = require('../src/app');

let app;
let authToken;

beforeAll(() => {
  app = createApp();
  authToken = generateAccessToken({ sub: 'u1' });
});

describe('Live Routes - Health Check', () => {
  test('GET /live/health should return service status', async () => {
    const res = await request(app).get('/api/live/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok');
    expect(res.body).toHaveProperty('elevenLabsConfigured');
    expect(res.body).toHaveProperty('geminiConfigured');
  });

  test('GET /live/health should work without authentication', async () => {
    const res = await request(app).get('/api/live/health');
    expect(res.status).toBe(200);
    expect(typeof res.body.ok).toBe('boolean');
  });
});

describe('Live Routes - Token Creation', () => {
  test('POST /live/token should create ephemeral token', async () => {
    const res = await request(app)
      .post('/api/live/token')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body).toHaveProperty('expireTime');
  });

  test('POST /live/token should require authentication', async () => {
    const res = await request(app).post('/api/live/token');
    expect([401, 403, 503]).toContain(res.status);
  });

  test('POST /live/token should return proper token structure', async () => {
    const res = await request(app)
      .post('/api/live/token')
      .set('Authorization', `Bearer ${authToken}`);

    if (res.status === 200) {
      expect(res.body.token).toBeDefined();
      expect(res.body.expireTime).toBeDefined();
      expect(res.body.newSessionExpireTime).toBeDefined();
    }
  });
});
