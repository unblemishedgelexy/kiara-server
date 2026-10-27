'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { env } = require('../config/env');
const Admin = require('../models/Admin');
const User = require('../models/User');
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

test('first admin registration succeeds without a key despite a matching regular user email', async () => {
  const originals = {
    registrationKey: env.adminRegistrationKey,
    adminFindOne: Admin.findOne,
    userFindOne: User.findOne,
    createIndex: Admin.collection.createIndex,
    countDocuments: Admin.countDocuments,
    create: Admin.create,
    hashPassword: authService.hashPassword,
  };
  let createdAdmin;
  let userLookupCalled = false;
  const response = createResponse();
  try {
    env.adminRegistrationKey = '';
    Admin.findOne = async () => null;
    User.findOne = async () => {
      userLookupCalled = true;
      return { role: 'user', email: 'admin@example.com' };
    };
    Admin.collection.createIndex = async () => 'unique_initial_admin';
    Admin.countDocuments = async () => 0;
    Admin.create = async (data) => {
      createdAdmin = data;
      return { ...data, id: 'initial-admin-id' };
    };
    authService.hashPassword = async () => 'password-hash';

    await register({
      validated: { body: {
        firstName: 'First',
        lastName: 'Admin',
        email: 'admin@example.com',
        password: 'a-long-password',
      } },
      get: () => undefined,
    }, response, (error) => { throw error; });

    assert.equal(response.statusCode, 201);
    assert.equal(response.body.success, true);
    assert.equal(createdAdmin.isInitialAdmin, true);
    assert.equal(createdAdmin.role, 'admin');
    assert.equal(userLookupCalled, false);
  } finally {
    env.adminRegistrationKey = originals.registrationKey;
    Admin.findOne = originals.adminFindOne;
    User.findOne = originals.userFindOne;
    Admin.collection.createIndex = originals.createIndex;
    Admin.countDocuments = originals.countDocuments;
    Admin.create = originals.create;
    authService.hashPassword = originals.hashPassword;
  }
});

test('later admin registrations require the configured registration key', async () => {
  const originals = {
    registrationKey: env.adminRegistrationKey,
    findOne: Admin.findOne,
    createIndex: Admin.collection.createIndex,
    countDocuments: Admin.countDocuments,
    create: Admin.create,
  };
  const response = createResponse();
  try {
    env.adminRegistrationKey = '';
    Admin.findOne = async () => null;
    Admin.collection.createIndex = async () => 'unique_initial_admin';
    Admin.countDocuments = async () => 1;
    Admin.create = async () => { throw new Error('Must not create a second unkeyed admin.'); };

    await register({
      validated: { body: {
        firstName: 'Second',
        lastName: 'Admin',
        email: 'second@example.com',
        password: 'another-long-password',
      } },
      get: () => undefined,
    }, response, (error) => { throw error; });

    assert.equal(response.statusCode, 503);
    assert.match(response.body.message, /configure ADMIN_REGISTRATION_KEY/i);
  } finally {
    env.adminRegistrationKey = originals.registrationKey;
    Admin.findOne = originals.findOne;
    Admin.collection.createIndex = originals.createIndex;
    Admin.countDocuments = originals.countDocuments;
    Admin.create = originals.create;
  }
});

test('a concurrent first-admin bootstrap loser receives a conflict', async () => {
  const originals = {
    registrationKey: env.adminRegistrationKey,
    findOne: Admin.findOne,
    createIndex: Admin.collection.createIndex,
    countDocuments: Admin.countDocuments,
    create: Admin.create,
    hashPassword: authService.hashPassword,
  };
  const response = createResponse();
  try {
    env.adminRegistrationKey = '';
    Admin.findOne = async () => null;
    Admin.collection.createIndex = async () => 'unique_initial_admin';
    Admin.countDocuments = async () => 0;
    Admin.create = async () => {
      throw Object.assign(new Error('duplicate initial admin'), {
        code: 11000,
        keyPattern: { isInitialAdmin: 1 },
      });
    };
    authService.hashPassword = async () => 'password-hash';

    await register({
      validated: { body: {
        firstName: 'Concurrent',
        lastName: 'Admin',
        email: 'concurrent@example.com',
        password: 'another-long-password',
      } },
      get: () => undefined,
    }, response, (error) => { throw error; });

    assert.equal(response.statusCode, 409);
    assert.match(response.body.message, /already been created/i);
  } finally {
    env.adminRegistrationKey = originals.registrationKey;
    Admin.findOne = originals.findOne;
    Admin.collection.createIndex = originals.createIndex;
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
