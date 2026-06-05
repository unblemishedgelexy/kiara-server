const request = require('supertest');
const { createSessionToken } = require('../src/utils/authCookies');

const mockedMemoryService = {
  addShortTerm: jest.fn(async (input) => ({ _id: 'm1', ...input })),
  getShortTerm: jest.fn(async (sessionId) => [{ sessionId, message: 'hello' }]),
  deleteShortTerm: jest.fn(async () => ({})),
  analyzeAndSaveLongTerm: jest.fn(async () => ({ stored: false })),
  getLongTerm: jest.fn(async () => []),
  deleteLongTerm: jest.fn(async () => ({})),
  patchLongTerm: jest.fn(async () => ({})),
};

jest.mock('../src/services/memoryService', () => mockedMemoryService);
const createApp = require('../src/app');

let app;
let authToken;

beforeAll(() => {
  app = createApp();
  authToken = createSessionToken({ id: 'u1' });
});

describe('Memory Routes - Short-term Memory (Redis)', () => {
  test('POST /memory/short/add should add short memory with all fields', async () => {
    const res = await request(app)
      .post('/memory/short/add')
      .send({ sessionId: 's1', role: 'user', message: 'hello world' })
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
  });

  test('POST /memory/short/add should return error without auth', async () => {
    const res = await request(app)
      .post('/memory/short/add')
      .send({ sessionId: 's1', role: 'user', message: 'hello' });

    expect([401, 403]).toContain(res.status);
  });

  test('GET /memory/short/:sessionId should return short memories', async () => {
    const res = await request(app)
      .get('/memory/short/s1')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.success).toBe(true);
  });

  test('GET /memory/short/:sessionId should require auth', async () => {
    const res = await request(app).get('/memory/short/s1');
    expect([401, 403]).toContain(res.status);
  });

  test('DELETE /memory/short/:sessionId should delete short memory', async () => {
    const res = await request(app)
      .delete('/memory/short/s1')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('DELETE /memory/short/:sessionId should require auth', async () => {
    const res = await request(app).delete('/memory/short/s1');
    expect([401, 403]).toContain(res.status);
  });
});

describe('Memory Routes - Long-term Memory (MongoDB)', () => {
  test('POST /memory/long/analyze should analyze and save long memory', async () => {
    const res = await request(app)
      .post('/memory/long/analyze')
      .send({ text: 'Important information to remember' })
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
  });

  test('POST /memory/long/analyze should require auth', async () => {
    const res = await request(app)
      .post('/memory/long/analyze')
      .send({ text: 'Some text' });

    expect([401, 403]).toContain(res.status);
  });

  test('GET /memory/long should return long-term memories', async () => {
    const res = await request(app)
      .get('/memory/long')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.success).toBe(true);
  });

  test('GET /memory/long should require auth', async () => {
    const res = await request(app).get('/memory/long');
    expect([401, 403]).toContain(res.status);
  });

  test('DELETE /memory/long/:id should delete long memory', async () => {
    const res = await request(app)
      .delete('/memory/long/mem123')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('PATCH /memory/long/:id should update long memory', async () => {
    const res = await request(app)
      .patch('/memory/long/mem123')
      .send({ content: 'Updated memory content' })
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
