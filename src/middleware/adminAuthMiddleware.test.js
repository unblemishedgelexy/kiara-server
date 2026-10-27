'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { generateAccessToken } = require('../services/auth/tokenService');
const adminAuthMiddleware = require('./adminAuthMiddleware');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('admin middleware only accepts admin access tokens', () => {
  const response = createResponse();
  const req = {
    headers: {
      authorization: `Bearer ${generateAccessToken({ sub: 'admin-id', tokenType: 'admin' })}`,
    },
  };
  let nextCalled = false;

  adminAuthMiddleware(req, response, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(req.userId, 'admin-id');
  assert.equal(req.adminId, 'admin-id');
});

test('admin middleware rejects regular user access tokens', () => {
  const response = createResponse();
  const req = {
    headers: {
      authorization: `Bearer ${generateAccessToken({ sub: 'user-id' })}`,
    },
  };
  let nextCalled = false;

  adminAuthMiddleware(req, response, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.message, 'Invalid admin access token.');
});
