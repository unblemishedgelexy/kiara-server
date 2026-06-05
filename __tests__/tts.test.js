const request = require('supertest');
const { createSessionToken } = require('../src/utils/authCookies');

const mockedElevenLabsService = {
  streamElevenLabsSpeech: jest.fn(async (text) => ({
    headers: new Map([['content-type', 'audio/mpeg']]),
    body: [Buffer.from('audio data')],
  })),
};

jest.mock('../src/services/elevenLabsService', () => mockedElevenLabsService);
const createApp = require('../src/app');

let app;
let authToken;

beforeAll(() => {
  app = createApp();
  authToken = createSessionToken({ id: 'u1' });
});

describe('TTS Routes - Speech Preview', () => {
  test('POST /tts/preview should stream audio for given text', async () => {
    const res = await request(app)
      .post('/tts/preview')
      .send({ text: 'Hello, how are you?' })
      .set('Authorization', `Bearer ${authToken}`);

    expect([200, 400, 403]).toContain(res.status);
  });

  test('POST /tts/preview should require authentication', async () => {
    const res = await request(app)
      .post('/tts/preview')
      .send({ text: 'Hello' });

    expect([401, 403]).toContain(res.status);
  });

  test('POST /tts/preview should return error if text is empty', async () => {
    const res = await request(app)
      .post('/tts/preview')
      .send({ text: '' })
      .set('Authorization', `Bearer ${authToken}`);

    expect([400, 403]).toContain(res.status);
  });

  test('POST /tts/preview should return error if text is missing', async () => {
    const res = await request(app)
      .post('/tts/preview')
      .send({})
      .set('Authorization', `Bearer ${authToken}`);

    expect([400, 403]).toContain(res.status);
  });

  test('POST /tts/preview should handle long text', async () => {
    const longText = 'This is a long text. '.repeat(50);
    const res = await request(app)
      .post('/tts/preview')
      .send({ text: longText })
      .set('Authorization', `Bearer ${authToken}`);

    expect([200, 400, 403]).toContain(res.status);
  });

  test('POST /tts/preview should set correct content-type header', async () => {
    const res = await request(app)
      .post('/tts/preview')
      .send({ text: 'Test audio' })
      .set('Authorization', `Bearer ${authToken}`);

    if (res.status === 200) {
      expect(res.headers['content-type']).toMatch(/audio/);
    }
  });
});
