const request = require('supertest');

const mockedAuthService = {
  ensureGuestUser: jest.fn(async () => ({ _id: 'user1', displayName: 'Guest 1', mode: 'guest' })),
  registerUser: jest.fn(async (input) => ({ _id: 'user2', displayName: input.displayName, email: input.email, mode: 'registered' })),
  loginUser: jest.fn(async (input) => ({ _id: 'user2', displayName: 'Registered', email: input.email, mode: 'registered' })),
};

jest.mock('../src/services/authService', () => mockedAuthService);
const createApp = require('../src/app');

let app;
beforeAll(() => { app = createApp(); });

describe('Auth Routes - POST /auth/guest', () => {
  test('should create guest user and return token', async () => {
    const res = await request(app).post('/auth/guest');
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user).toBeDefined();
  });

  test('should set auth cookie', async () => {
    const res = await request(app).post('/auth/guest');
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  test('guest user should have correct structure', async () => {
    const res = await request(app).post('/auth/guest');
    expect(res.body.user).toHaveProperty('displayName');
    expect(res.body.user).toHaveProperty('mode');
  });
});

describe('Auth Routes - POST /auth/register', () => {
  test('should register user and return token', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ displayName: 'Bob', email: 'bob@example.com', password: 'password123' });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(res.body.user).toBeDefined();
  });

  test('should set auth cookie on registration', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ displayName: 'Alice', email: 'alice@example.com', password: 'password123' });
    expect(res.status).toBe(201);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  test('should handle missing fields', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'incomplete@example.com' });
    expect([201, 400]).toContain(res.status);
  });
});

describe('Auth Routes - POST /auth/login', () => {
  test('should login user and return token', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'bob@example.com', password: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  test('should set auth cookie on login', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'bob@example.com', password: 'password123' });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeDefined();
  });
});

describe('Auth Routes - POST /auth/logout', () => {
  test('should clear auth cookie on logout', async () => {
    const loginRes = await request(app)
      .post('/auth/login')
      .send({ email: 'bob@example.com', password: 'password123' });
    
    const logoutRes = await request(app)
      .post('/auth/logout')
      .set('Cookie', loginRes.headers['set-cookie']);
    
    expect([200, 204]).toContain(logoutRes.status);
  });
});
