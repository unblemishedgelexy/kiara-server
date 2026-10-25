const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const UserModel = require('../../models/User');
const SessionModel = require('../../models/Session');
const otpService = require('./otpServiceV2');
const authService = require('./authService');
const accountDeletionService = require('../accountDeletionService');

test('registration creates an unverified user and sends an OTP without issuing tokens', async () => {
  const originals = {
    findOne: UserModel.findOne,
    create: UserModel.create,
    createAndSendOTP: otpService.createAndSendOTP,
  };
  let createdUser;
  let sentType;

  try {
    UserModel.findOne = async () => null;
    UserModel.create = async (data) => {
      createdUser = { ...data, _id: 'user-test' };
      return createdUser;
    };
    otpService.createAndSendOTP = async (_email, type) => { sentType = type; return { success: true }; };

    const result = await authService.registerUser({
      firstName: 'Test',
      lastName: 'User',
      email: 'test.user@gmail.com',
      password: 'a-test-password',
    });

    assert.equal(createdUser.emailVerified, false);
    assert.equal(sentType, 'REGISTER_EMAIL');
    assert.equal(result.user.emailVerified, false);
    assert.equal('accessToken' in result, false);
    assert.equal('refreshToken' in result, false);
  } finally {
    UserModel.findOne = originals.findOne;
    UserModel.create = originals.create;
    otpService.createAndSendOTP = originals.createAndSendOTP;
  }
});

test('direct registration rejects email domains other than gmail.com', async () => {
  const originalFindOne = UserModel.findOne;
  let userLookupAttempted = false;

  try {
    UserModel.findOne = async () => {
      userLookupAttempted = true;
      return null;
    };

    await assert.rejects(
      authService.registerUser({
        firstName: 'Test',
        lastName: 'User',
        email: 'test.user@googlemail.com',
        password: 'a-test-password',
      }),
      /Only @gmail\.com/i,
    );
    assert.equal(userLookupAttempted, false);
    assert.equal(authService.isValidGmailAccount('test.user@gmail.com'), true);
    assert.equal(authService.isValidGmailAccount('test.user@googlemail.com'), false);
  } finally {
    UserModel.findOne = originalFindOne;
  }
});

test('Google OAuth accepts a provider-verified email on a non-Gmail domain without app OTP', async () => {
  const originals = {
    findOne: UserModel.findOne,
    create: UserModel.create,
    findByIdAndUpdate: UserModel.findByIdAndUpdate,
    createSession: SessionModel.create,
    createAndSendOTP: otpService.createAndSendOTP,
    cancelDeletionAfterLogin: accountDeletionService.cancelDeletionAfterLogin,
    deletionRequestDeleteMany: require('../../models/AccountDeletionRequest').deleteMany,
  };
  let createdUser;
  let otpRequested = false;

  try {
    UserModel.findOne = async () => null;
    UserModel.create = async (data) => {
      createdUser = { ...data, _id: 'google-user-test' };
      return createdUser;
    };
    UserModel.findByIdAndUpdate = async () => null;
    SessionModel.create = async (data) => data;
    accountDeletionService.cancelDeletionAfterLogin = async () => {};
    require('../../models/AccountDeletionRequest').deleteMany = async () => ({ deletedCount: 0 });
    otpService.createAndSendOTP = async () => {
      otpRequested = true;
      throw new Error('Google OAuth must not request an app OTP.');
    };

    const result = await authService.loginWithGoogle({
      googleId: 'google-user-id',
      email: 'user@company.example',
      googleEmail: 'user@company.example',
    });

    assert.equal(createdUser.email, 'user@company.example');
    assert.equal(createdUser.emailVerified, true);
    assert.equal(result.user.email, 'user@company.example');
    assert.equal(Boolean(result.accessToken), true);
    assert.equal(otpRequested, false);
  } finally {
    UserModel.findOne = originals.findOne;
    UserModel.create = originals.create;
    UserModel.findByIdAndUpdate = originals.findByIdAndUpdate;
    SessionModel.create = originals.createSession;
    otpService.createAndSendOTP = originals.createAndSendOTP;
    accountDeletionService.cancelDeletionAfterLogin = originals.cancelDeletionAfterLogin;
    require('../../models/AccountDeletionRequest').deleteMany = originals.deletionRequestDeleteMany;
  }
});

test('password login refuses an otherwise valid unverified account', async () => {
  const originals = {
    findOne: UserModel.findOne,
    cancelDeletionAfterLogin: accountDeletionService.cancelDeletionAfterLogin,
  };
  const user = {
    email: 'test.user@gmail.com',
    emailVerified: false,
    passwordHash: await bcrypt.hash('a-test-password', 4),
  };

  try {
    UserModel.findOne = async () => user;
    accountDeletionService.cancelDeletionAfterLogin = async () => {};
    await assert.rejects(
      authService.loginWithEmailPassword(user.email, 'a-test-password'),
      /verify your email/i,
    );
  } finally {
    UserModel.findOne = originals.findOne;
    accountDeletionService.cancelDeletionAfterLogin = originals.cancelDeletionAfterLogin;
  }
});
