'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { env } = require('../config/env');
const Admin = require('../models/Admin');
const authService = require('../services/auth/authService');
const {
  hasAdminPasswordAccess,
  isRegistrationKeyValid,
  login,
  register,
} = require('./adminAuthController');

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

test('admin registration key must be configured and match exactly', () => {
  const originalKey = env.adminRegistrationKey;
  try {
    env.adminRegistrationKey = 'test-registration-key';
    assert.equal(isRegistrationKeyValid('test-registration-key'), true);
    assert.equal(isRegistrationKeyValid('wrong-registration-key'), false);
    assert.equal(isRegistrationKeyValid(undefined), false);
    env.adminRegistrationKey = '';
    assert.equal(isRegistrationKeyValid('test-registration-key'), false);
  } finally {
    env.adminRegistrationKey = originalKey;
  }
});

test('first-admin bootstrap is disabled even with the registration key', async () => {
  const originals = {
    registrationKey: env.adminRegistrationKey,
    adminFindOne: Admin.findOne,
    countDocuments: Admin.countDocuments,
    create: Admin.create,
    hashPassword: authService.hashPassword,
  };
  let accountCreated = false;
  const response = createResponse();
  try {
    env.adminRegistrationKey = 'secure-test-registration-key';
    Admin.findOne = async () => null;
    Admin.countDocuments = async () => 0;
    Admin.create = async () => {
      accountCreated = true;
      throw new Error('First-admin bootstrap must remain disabled.');
    };
    authService.hashPassword = async () => 'password-hash';

    await register({
      validated: { body: {
        firstName: 'First',
        lastName: 'Admin',
        email: 'admin@example.com',
        password: 'a-long-password',
      } },
      get: () => env.adminRegistrationKey,
    }, response, (error) => { throw error; });

    assert.equal(response.statusCode, 403);
    assert.match(response.body.message, /first-admin bootstrap is disabled/i);
    assert.equal(accountCreated, false);
  } finally {
    env.adminRegistrationKey = originals.registrationKey;
    Admin.findOne = originals.adminFindOne;
    Admin.countDocuments = originals.countDocuments;
    Admin.create = originals.create;
    authService.hashPassword = originals.hashPassword;
  }
});

test('additional admin registration requires the configured key', async () => {
  const originals = {
    registrationKey: env.adminRegistrationKey,
    findOne: Admin.findOne,
    countDocuments: Admin.countDocuments,
    create: Admin.create,
    hashPassword: authService.hashPassword,
  };
  let createdAdmin;
  const response = createResponse();
  try {
    env.adminRegistrationKey = 'secure-test-registration-key';
    Admin.findOne = async () => null;
    Admin.countDocuments = async () => 1;
    Admin.create = async (data) => {
      createdAdmin = data;
      return { ...data, id: 'additional-admin-id' };
    };
    authService.hashPassword = async () => 'password-hash';

    await register({
      validated: { body: {
        firstName: 'Second',
        lastName: 'Admin',
        email: 'second@example.com',
        password: 'another-long-password',
      } },
      get: () => undefined,
    }, response, (error) => { throw error; });

    assert.equal(response.statusCode, 401);
    assert.match(response.body.message, /invalid admin registration key/i);

    await register({
      validated: { body: {
        firstName: 'Second',
        lastName: 'Admin',
        email: 'second@example.com',
        password: 'another-long-password',
      } },
      get: () => 'wrong-registration-key',
    }, response, (error) => { throw error; });

    assert.equal(response.statusCode, 401);

    await register({
      validated: { body: {
        firstName: 'Second',
        lastName: 'Admin',
        email: 'second@example.com',
        password: 'another-long-password',
      } },
      get: () => env.adminRegistrationKey,
    }, response, (error) => { throw error; });

    assert.equal(response.statusCode, 201);
    assert.equal(response.body.success, true);
    assert.equal(createdAdmin.role, 'admin');
    assert.equal(Object.hasOwn(createdAdmin, 'isInitialAdmin'), false);
  } finally {
    env.adminRegistrationKey = originals.registrationKey;
    Admin.findOne = originals.findOne;
    Admin.countDocuments = originals.countDocuments;
    Admin.create = originals.create;
    authService.hashPassword = originals.hashPassword;
  }
});

test('only active admin and dev accounts with password login can enter the panel', () => {
  assert.equal(hasAdminPasswordAccess({
    role: 'admin', isActive: true, emailVerified: true, passwordHash: 'hash',
  }), true);
  assert.equal(hasAdminPasswordAccess({
    role: 'dev', isActive: true, emailVerified: true, passwordHash: 'hash',
  }), true);
  assert.equal(hasAdminPasswordAccess({
    role: 'user', isActive: true, emailVerified: true, passwordHash: 'hash',
  }), false);
  assert.equal(hasAdminPasswordAccess({
    role: 'admin', isActive: false, emailVerified: true, passwordHash: 'hash',
  }), false);
  assert.equal(hasAdminPasswordAccess({
    role: 'admin', isActive: true, emailVerified: false, passwordHash: 'hash',
  }), false);
});

test('admin login signs an admin-specific token from the Admin collection', async () => {
  const originals = {
    findOne: Admin.findOne,
    comparePassword: authService.comparePassword,
  };
  const admin = {
    _id: 'admin-account-id',
    id: 'admin-account-id',
    firstName: 'Kiara',
    lastName: 'Admin',
    email: 'admin@example.com',
    role: 'admin',
    isActive: true,
    emailVerified: true,
    passwordHash: 'stored-hash',
    save: async () => {},
  };
  const response = createResponse();
  try {
    Admin.findOne = () => ({
      select: async () => admin,
    });
    authService.comparePassword = async () => true;
    await login({
      validated: { body: { email: admin.email, password: 'a-long-password' } },
      headers: {},
      ip: '127.0.0.1',
    }, response, (error) => { throw error; });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.data.user.id, admin.id);
    assert.equal(require('../services/auth/tokenService').verifyAccessToken(
      response.body.data.accessToken,
    ).tokenType, 'admin');
  } finally {
    Admin.findOne = originals.findOne;
    authService.comparePassword = originals.comparePassword;
  }
});
