const assert = require('node:assert/strict');
const test = require('node:test');
const UserModel = require('../models/User');
const { generateAccessToken } = require('../services/auth/tokenService');
const authMiddleware = require('./authMiddleware');

test('inactive accounts cannot use an existing access token', async () => {
  const originalFindById = UserModel.findById;
  const token = generateAccessToken({ sub: 'inactive-user' });
  let responseStatus;
  let responseBody;
  let nextCalled = false;

  try {
    UserModel.findById = () => ({
      select: () => ({ lean: async () => ({ isActive: false }) }),
    });
    const response = {
      status(status) {
        responseStatus = status;
        return this;
      },
      json(body) {
        responseBody = body;
        return this;
      },
    };

    await authMiddleware(
      { headers: { 'x-access-token': token } },
      response,
      () => { nextCalled = true; },
    );

    assert.equal(responseStatus, 403);
    assert.equal(responseBody.code, 'ACCOUNT_INACTIVE');
    assert.equal(nextCalled, false);
  } finally {
    UserModel.findById = originalFindById;
  }
});
