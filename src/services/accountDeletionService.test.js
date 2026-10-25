const assert = require('node:assert/strict');
const test = require('node:test');
const bcrypt = require('bcryptjs');
const AccountDeletionRequest = require('../models/AccountDeletionRequest');
const UserModel = require('../models/User');
const SessionModel = require('../models/Session');
const emailService = require('./infrastructure/emailService');
const subscriptionService = require('./subscriptions/subscriptionService');
const otpService = require('./auth/otpServiceV2');
const accountDeletionService = require('./accountDeletionService');

test('password-protected deletion requires a password and sends a one-time email code', async () => {
  const originals = {
    findById: UserModel.findById,
    findOne: AccountDeletionRequest.findOne,
    deleteOne: AccountDeletionRequest.deleteOne,
    createAndSendOTP: otpService.createAndSendOTP,
  };
  const passwordHash = await bcrypt.hash('correct-password', 4);
  let sentType;
  let sentMeta;

  try {
    UserModel.findById = () => ({
      select: async () => ({
        _id: 'user-id',
        email: 'user@gmail.com',
        emailVerified: true,
        passwordHash,
        passwordLoginEnabled: true,
        isActive: true,
      }),
    });
    AccountDeletionRequest.findOne = () => ({ sort: async () => null });
    AccountDeletionRequest.deleteOne = async () => ({ deletedCount: 0 });
    otpService.createAndSendOTP = async (_email, type, options) => {
      sentType = type;
      sentMeta = options.meta;
      return { success: true, expiresIn: 600 };
    };

    await assert.rejects(
      accountDeletionService.beginSecureAction('user-id', 'account_deletion'),
      { code: 'SECURE_ACTION_PASSWORD_REQUIRED' },
    );
    await assert.rejects(
      accountDeletionService.beginSecureAction('user-id', 'account_deletion', 'wrong-password'),
      { code: 'SECURE_ACTION_PASSWORD_INVALID' },
    );
    const result = await accountDeletionService.beginSecureAction(
      'user-id',
      'account_deletion',
      'correct-password',
    );

    assert.equal(result.requiresOtp, true);
    assert.equal(sentType, 'ACCOUNT_DELETION_EMAIL');
    assert.equal(sentMeta.userName, 'there');

    await accountDeletionService.beginSecureAction(
      'user-id',
      'memory_deletion',
      'correct-password',
    );
    assert.equal(sentType, 'MEMORY_DELETION_EMAIL');
  } finally {
    UserModel.findById = originals.findById;
    AccountDeletionRequest.findOne = originals.findOne;
    AccountDeletionRequest.deleteOne = originals.deleteOne;
    otpService.createAndSendOTP = originals.createAndSendOTP;
  }
});

test('Google-only account can verify by email code and schedule immediate deactivation without a second email', async () => {
  const originals = {
    findById: UserModel.findById,
    create: AccountDeletionRequest.create,
    updateOne: AccountDeletionRequest.updateOne,
    userUpdateOne: UserModel.updateOne,
    deleteSessions: SessionModel.deleteMany,
    cancelCurrentSubscription: subscriptionService.cancelCurrentSubscription,
    verifyOTPCode: otpService.verifyOTPCode,
  };
  const user = {
    _id: 'user-id',
    email: 'user@example.org',
    emailVerified: true,
    isActive: true,
    passwordLoginEnabled: false,
  };
  let createdRequest;
  let sessionRevoked = false;
  let verificationType;

  try {
    UserModel.findById = () => ({ select: async () => user });
    AccountDeletionRequest.create = async (data) => {
      createdRequest = { _id: 'deletion-request', ...data };
      return createdRequest;
    };
    AccountDeletionRequest.updateOne = async () => ({ modifiedCount: 1 });
    UserModel.updateOne = async (_filter, changes) => {
      assert.equal(changes.$set.isActive, false);
      return { modifiedCount: 1 };
    };
    SessionModel.deleteMany = async () => {
      sessionRevoked = true;
      return { deletedCount: 1 };
    };
    subscriptionService.cancelCurrentSubscription = async () => {};
    otpService.verifyOTPCode = async (_email, code, type) => {
      verificationType = type;
      return { success: code === '123456' };
    };

    const result = await accountDeletionService.completeSecureAction('user-id', 'account_deletion', '123456');

    assert.equal(result.status, 'scheduled');
    assert.equal(verificationType, 'ACCOUNT_DELETION_EMAIL');
    assert.equal(result.deleteAt.getTime() - createdRequest.requestedAt.getTime(), 10 * 24 * 60 * 60 * 1000);
    assert.equal(sessionRevoked, true);
  } finally {
    UserModel.findById = originals.findById;
    AccountDeletionRequest.create = originals.create;
    AccountDeletionRequest.updateOne = originals.updateOne;
    UserModel.updateOne = originals.userUpdateOne;
    SessionModel.deleteMany = originals.deleteSessions;
    subscriptionService.cancelCurrentSubscription = originals.cancelCurrentSubscription;
    otpService.verifyOTPCode = originals.verifyOTPCode;
  }
});

test('successful sign-in cancels a pending deletion request', async () => {
  const originals = {
    findOne: AccountDeletionRequest.findOne,
    updateMany: AccountDeletionRequest.updateMany,
    deleteMany: AccountDeletionRequest.deleteMany,
    userUpdateOne: UserModel.updateOne,
    sendAccountDeletionCancelled: emailService.sendAccountDeletionCancelled,
  };
  let cancellationFilter;
  let notificationCount = 0;
  const user = {
    _id: 'user-id',
    email: 'user@gmail.com',
    firstName: 'Kiara User',
    isActive: false,
  };

  try {
    AccountDeletionRequest.findOne = (filter) => ({
      lean: async () => filter.deleteAt?.$gt
        ? { _id: 'deletion-request', deleteAt: filter.deleteAt.$gt }
        : null,
    });
    AccountDeletionRequest.updateMany = async (filter) => {
      cancellationFilter = filter;
      return { modifiedCount: 1 };
    };
    AccountDeletionRequest.deleteMany = async () => ({ deletedCount: 1 });
    UserModel.updateOne = async (_filter, changes) => {
      assert.equal(changes.$set.isActive, true);
      return { modifiedCount: 1 };
    };
    emailService.sendAccountDeletionCancelled = async () => { notificationCount += 1; };

    await accountDeletionService.cancelDeletionAfterLogin(user);

    assert.equal(cancellationFilter.userId, 'user-id');
    assert.equal(notificationCount, 1);
    assert.equal(user.isActive, true);
  } finally {
    AccountDeletionRequest.findOne = originals.findOne;
    AccountDeletionRequest.updateMany = originals.updateMany;
    AccountDeletionRequest.deleteMany = originals.deleteMany;
    UserModel.updateOne = originals.userUpdateOne;
    emailService.sendAccountDeletionCancelled = originals.sendAccountDeletionCancelled;
  }
});

test('deletion request deactivates the account and starts the grace period immediately', async () => {
  const AccountDeletionRequest = require('../models/AccountDeletionRequest');
  const originals = {
    findById: UserModel.findById,
    userUpdateOne: UserModel.updateOne,
    findOne: AccountDeletionRequest.findOne,
    create: AccountDeletionRequest.create,
    updateOne: AccountDeletionRequest.updateOne,
    deleteOne: AccountDeletionRequest.deleteOne,
    deleteSessions: SessionModel.deleteMany,
    cancelCurrentSubscription: subscriptionService.cancelCurrentSubscription,
    verifyOTPCode: otpService.verifyOTPCode,
  };
  let userChanges;
  let createdRequest;
  let sessionsDeleted = false;

  try {
    UserModel.findById = () => ({
      select: async () => ({
        _id: 'user-id',
        email: 'user@gmail.com',
        emailVerified: true,
        isActive: true,
        firstName: 'Kiara User',
      }),
    });
    AccountDeletionRequest.findOne = () => ({ sort: async () => null });
    AccountDeletionRequest.create = async (data) => {
      createdRequest = { _id: 'deletion-request', ...data };
      return createdRequest;
    };
    AccountDeletionRequest.updateOne = async () => ({ modifiedCount: 1 });
    AccountDeletionRequest.deleteOne = async () => ({ deletedCount: 1 });
    UserModel.updateOne = async (_filter, changes) => {
      userChanges = changes;
      return { modifiedCount: 1 };
    };
    SessionModel.deleteMany = async () => {
      sessionsDeleted = true;
      return { deletedCount: 1 };
    };
    subscriptionService.cancelCurrentSubscription = async () => {};
    otpService.verifyOTPCode = async () => ({ success: true });

    const result = await accountDeletionService.completeSecureAction('user-id', 'account_deletion', '123456');

    assert.equal(result.status, 'scheduled');
    assert.equal(createdRequest.status, 'scheduled');
    assert.equal(result.deleteAt.getTime() - createdRequest.requestedAt.getTime(), 10 * 24 * 60 * 60 * 1000);
    assert.equal(userChanges.$set.isActive, false);
    assert.equal(userChanges.$set.refreshTokenHash, null);
    assert.equal(sessionsDeleted, true);
  } finally {
    UserModel.findById = originals.findById;
    UserModel.updateOne = originals.userUpdateOne;
    AccountDeletionRequest.findOne = originals.findOne;
    AccountDeletionRequest.create = originals.create;
    AccountDeletionRequest.updateOne = originals.updateOne;
    AccountDeletionRequest.deleteOne = originals.deleteOne;
    SessionModel.deleteMany = originals.deleteSessions;
    subscriptionService.cancelCurrentSubscription = originals.cancelCurrentSubscription;
    otpService.verifyOTPCode = originals.verifyOTPCode;
  }
});

test('sign-in cannot cancel deletion after its deadline', async () => {
  const originals = {
    findOne: AccountDeletionRequest.findOne,
    updateMany: AccountDeletionRequest.updateMany,
  };
  let cancellationAttempted = false;

  try {
    AccountDeletionRequest.findOne = () => ({
      lean: async () => ({ _id: 'deletion-request', deleteAt: new Date(Date.now() - 1) }),
    });
    AccountDeletionRequest.updateMany = async () => {
      cancellationAttempted = true;
      return { modifiedCount: 0 };
    };

    await assert.rejects(
      accountDeletionService.cancelDeletionAfterLogin({ _id: 'user-id' }),
      { code: 'ACCOUNT_DELETION_FINALIZED' },
    );
    assert.equal(cancellationAttempted, false);
  } finally {
    AccountDeletionRequest.findOne = originals.findOne;
    AccountDeletionRequest.updateMany = originals.updateMany;
  }
});
