const bcrypt = require('bcryptjs');
const AccountDeletionRequest = require('../models/AccountDeletionRequest');
const UserModel = require('../models/User');
const SessionModel = require('../models/Session');
const OTPModel = require('../models/OTP');
const AuthTicketModel = require('../models/AuthTicket');
const PasswordResetTokenModel = require('../models/PasswordResetToken');
const PendingRegistrationModel = require('../models/PendingRegistration');
const Subscription = require('../models/Subscription');
const SubscriptionUsage = require('../models/SubscriptionUsage');
const RazorpayPayment = require('../models/RazorpayPayment');
const SupportRequest = require('../models/SupportRequest');
const subscriptionService = require('./subscriptions/subscriptionService');
const emailService = require('./infrastructure/emailService');
const { deleteFileFromImageKit } = require('./imageService');
const { wipeUserMemory } = require('./memory/deletion/userMemoryWipeService');
const otpService = require('./auth/otpServiceV2');
const { OTP_TYPES } = require('../config/otpTypes');

const GRACE_PERIOD_DAYS = 10;
const RETRY_DELAY_MS = 5 * 60 * 1000;
const PROCESSING_LEASE_MS = 10 * 60 * 1000;

function deletionDateFrom(now) {
  return new Date(now.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
}

async function deactivateAccount(userId) {
  const result = await UserModel.updateOne(
    { _id: userId, isActive: true },
    { $set: { isActive: false, refreshTokenHash: null } },
  );
  if (result.modifiedCount !== 1) {
    const error = new Error('The account could not be deactivated for deletion.');
    error.code = 'ACCOUNT_DELETION_DEACTIVATION_FAILED';
    throw error;
  }
  await SessionModel.deleteMany({ userId });
}

function actionConfiguration(action) {
  if (action === 'account_deletion') {
    return { otpType: OTP_TYPES.ACCOUNT_DELETION_EMAIL };
  }
  if (action === 'memory_deletion') {
    return { otpType: OTP_TYPES.MEMORY_DELETION_EMAIL };
  }
  const error = new Error('Unsupported secure action.');
  error.code = 'SECURE_ACTION_INVALID';
  throw error;
}

function passwordLoginEnabled(user) {
  return user.passwordLoginEnabled === true
    || (!user.googleId && user.passwordLoginEnabled !== false);
}

async function beginSecureAction(userId, action, password, options = {}) {
  const { otpType } = actionConfiguration(action);
  const user = await UserModel.findById(userId).select('_id email firstName displayName emailVerified passwordHash passwordLoginEnabled googleId isActive');
  if (!user || !user.emailVerified || !user.isActive) {
    const error = new Error('An active, verified account is required.');
    error.code = 'SECURE_ACTION_ACCOUNT_UNAVAILABLE';
    throw error;
  }

  if (passwordLoginEnabled(user)) {
    if (typeof password !== 'string' || !password) {
      const error = new Error('Enter your password to continue.');
      error.code = 'SECURE_ACTION_PASSWORD_REQUIRED';
      throw error;
    }
    if (!await bcrypt.compare(password, user.passwordHash)) {
      const error = new Error('The password is incorrect.');
      error.code = 'SECURE_ACTION_PASSWORD_INVALID';
      throw error;
    }
  }

  if (action === 'account_deletion') {
    const current = await AccountDeletionRequest.findOne({
      userId: user._id,
      status: { $in: ['confirmation_pending', 'scheduled', 'processing'] },
    }).sort({ requestedAt: -1 });

    if (current?.status === 'scheduled' || current?.status === 'processing') {
      const error = new Error('An account deletion is already scheduled.');
      error.code = 'ACCOUNT_DELETION_ALREADY_SCHEDULED';
      throw error;
    }

    if (current) {
      await AccountDeletionRequest.deleteOne({ _id: current._id, status: 'confirmation_pending' });
    }
  }

  return {
    ...await otpService.createAndSendOTP(user.email, otpType, {
      ipAddress: options.ipAddress,
      userAgent: options.userAgent,
      meta: {
        userName: user.firstName || user.displayName || 'there',
        purpose: action === 'account_deletion' ? 'account deletion' : 'saved memory deletion',
      },
    }),
    action,
    requiresOtp: true,
    message: `A verification code was sent to ${user.email}. Enter it to ${action === 'account_deletion' ? 'deactivate your account' : 'delete your saved memories'}.`,
  };
}

async function cancelCurrentSubscriptionForDeletion(userId) {
  try {
    await subscriptionService.cancelCurrentSubscription(userId);
  } catch (error) {
    if (error.code !== 'SUBSCRIPTION_NOT_ACTIVE') throw error;
  }
}

async function completeSecureAction(userId, action, code) {
  const { otpType } = actionConfiguration(action);
  const user = await UserModel.findById(userId).select('_id email firstName displayName emailVerified isActive');
  if (!user || !user.emailVerified || !user.isActive) {
    const error = new Error('An active, verified account is required.');
    error.code = 'SECURE_ACTION_ACCOUNT_UNAVAILABLE';
    throw error;
  }
  const verification = await otpService.verifyOTPCode(user.email, code, otpType);
  if (!verification.success) {
    const error = new Error('The verification code is invalid or expired.');
    error.code = 'SECURE_ACTION_OTP_INVALID';
    throw error;
  }

  if (action === 'memory_deletion') {
    const memoryResult = await wipeUserMemory(String(user._id), { reason: 'user_request' });
    return { ...memoryResult, action };
  }

  const now = new Date();
  const request = await AccountDeletionRequest.create({
    userId: user._id,
    email: user.email,
    status: 'scheduled',
    requestedAt: now,
    confirmedAt: now,
    deleteAt: deletionDateFrom(now),
  });
  try {
    await cancelCurrentSubscriptionForDeletion(user._id);
    await deactivateAccount(user._id);
  } catch (error) {
    await AccountDeletionRequest.updateOne(
      { _id: request._id, status: 'scheduled' },
      { $set: { status: 'cancelled' } },
    );
    await UserModel.updateOne({ _id: user._id }, { $set: { isActive: true } });
    throw error;
  }

  return {
    success: true,
    action,
    status: request.status,
    deleteAt: request.deleteAt,
    message: 'Your account is deactivated and signed out. Sign in within 10 days to cancel deletion and reactivate it.',
  };
}

async function getAccountDeletionStatus(userId) {
  const request = await AccountDeletionRequest.findOne({
    userId,
    status: { $in: ['confirmation_pending', 'scheduled', 'processing'] },
  }).sort({ requestedAt: -1 }).lean();

  if (!request) return { success: true, status: 'none' };
  return {
    success: true,
    status: request.status,
    requestedAt: request.requestedAt,
    deleteAt: request.deleteAt,
  };
}

async function cancelAccountDeletion(userId) {
  const now = new Date();
  const activeRequest = await AccountDeletionRequest.findOne({
    userId,
    status: { $in: ['confirmation_pending', 'scheduled'] },
    $or: [
      { status: 'confirmation_pending' },
      { deleteAt: { $gt: now } },
    ],
  }).lean();
  const result = await AccountDeletionRequest.updateMany(
    {
      userId,
      status: { $in: ['confirmation_pending', 'scheduled'] },
      $or: [
        { status: 'confirmation_pending' },
        { deleteAt: { $gt: now } },
      ],
    },
    { $set: { status: 'cancelled' } },
  );
  if (result.modifiedCount > 0 && activeRequest) {
    const user = await UserModel.findById(userId).select('email firstName displayName').lean();
    if (user?.email) {
      try {
        await emailService.sendAccountDeletionCancelled({
          email: user.email,
          userName: user.firstName || user.displayName || 'there',
        });
      } catch (error) {
        console.error('[ACCOUNT_DELETION_EMAIL_FAILED]', error?.name || error?.code || 'email');
      }
    }
  }
  if (result.modifiedCount > 0) {
    await UserModel.updateOne({ _id: userId }, { $set: { isActive: true } });
    await AccountDeletionRequest.deleteMany({ userId, status: 'cancelled' });
  }
  return { success: true, cancelled: result.modifiedCount > 0 };
}

async function cancelDeletionAfterLogin(user) {
  const now = new Date();
  const expired = await AccountDeletionRequest.findOne({
    userId: user._id,
    status: 'scheduled',
    deleteAt: { $lte: now },
  }).lean();

  if (expired) {
    const error = new Error('The account deletion grace period has ended. This account can no longer sign in.');
    error.code = 'ACCOUNT_DELETION_FINALIZED';
    throw error;
  }

  if (user.isActive === false) {
    const scheduledDeletion = await AccountDeletionRequest.findOne({
      userId: user._id,
      status: 'scheduled',
      deleteAt: { $gt: now },
    }).lean();
    if (!scheduledDeletion) {
      const error = new Error('This account is inactive and cannot sign in.');
      error.code = 'ACCOUNT_INACTIVE';
      throw error;
    }
  }

  const result = await AccountDeletionRequest.updateMany(
    {
      userId: user._id,
      $or: [
        { status: 'confirmation_pending' },
        { status: 'scheduled', deleteAt: { $gt: now } },
      ],
    },
    { $set: { status: 'cancelled' }, $unset: { tokenHash: 1 } },
  );

  if (result.modifiedCount === 0 && user.isActive === false) {
    const error = new Error('This account is inactive and cannot sign in.');
    error.code = 'ACCOUNT_INACTIVE';
    throw error;
  }

  if (result.modifiedCount > 0) {
    try {
      const activation = await UserModel.updateOne(
        { _id: user._id, isActive: false },
        { $set: { isActive: true } },
      );
      if (activation.modifiedCount !== 1) {
        const error = new Error('The account could not be reactivated after cancelling deletion.');
        error.code = 'ACCOUNT_DELETION_REACTIVATION_FAILED';
        throw error;
      }
      user.isActive = true;
    } catch (error) {
      await AccountDeletionRequest.updateMany(
        { userId: user._id, status: 'cancelled', deleteAt: { $gt: now } },
        { $set: { status: 'scheduled' } },
      );
      throw error;
    }
  }

  if (result.modifiedCount === 0) {
    const deletionInProgress = await AccountDeletionRequest.findOne({
      userId: user._id,
      $or: [
        { status: 'processing' },
        { status: 'scheduled', deleteAt: { $lte: new Date() } },
      ],
    }).lean();
    if (deletionInProgress) {
      const error = new Error('The account deletion grace period has ended. This account can no longer sign in.');
      error.code = 'ACCOUNT_DELETION_FINALIZED';
      throw error;
    }
  }

  if (result.modifiedCount > 0) {
    try {
      await emailService.sendAccountDeletionCancelled({
        email: user.email,
        userName: user.firstName || user.displayName || 'there',
      });
    } catch (error) {
      console.error('[ACCOUNT_DELETION_EMAIL_FAILED]', error?.name || error?.code || 'email');
    }
    await AccountDeletionRequest.deleteMany({ userId: user._id, status: 'cancelled' });
  }
}

async function deleteAccountData(request) {
  const user = await UserModel.findById(request.userId).lean();
  if (!user) return;

  const memoryResult = await wipeUserMemory(String(request.userId), { reason: 'user_request' });
  if (!memoryResult.success) {
    const error = new Error('Memory deletion did not complete across all configured stores.');
    error.code = 'ACCOUNT_MEMORY_DELETE_INCOMPLETE';
    throw error;
  }

  if (user.profilePictureFileId) {
    await deleteFileFromImageKit(user.profilePictureFileId);
  }

  await Promise.all([
    SessionModel.deleteMany({ userId: request.userId }),
    OTPModel.deleteMany({ identifier: request.email }),
    AuthTicketModel.deleteMany({ userId: request.userId }),
    PasswordResetTokenModel.deleteMany({ userId: request.userId }),
    PendingRegistrationModel.deleteMany({ email: request.email }),
    SubscriptionUsage.deleteMany({ userId: request.userId }),
    Subscription.deleteMany({ userId: request.userId }),
    SupportRequest.deleteMany({ userId: request.userId }),
    RazorpayPayment.updateMany({ userId: request.userId }, { $unset: { userId: 1 } }),
  ]);

  const deletion = await UserModel.deleteOne({ _id: request.userId });
  if (deletion.deletedCount !== 1) {
    const error = new Error('Account record deletion could not be confirmed.');
    error.code = 'ACCOUNT_DELETE_INCOMPLETE';
    throw error;
  }

  try {
    await emailService.sendAccountDeletionComplete({
      email: request.email,
      userName: user.firstName || user.displayName || 'there',
    });
  } catch (error) {
    console.error('[ACCOUNT_DELETION_EMAIL_FAILED]', error?.name || error?.code || 'email');
  }
}

let workerTimer = null;
let workerRunning = false;

async function runDeletionWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    const staleBefore = new Date(Date.now() - PROCESSING_LEASE_MS);
    await AccountDeletionRequest.deleteMany({
      status: 'confirmation_pending',
      tokenExpiresAt: { $lte: new Date() },
    });
    await AccountDeletionRequest.deleteMany({ status: 'cancelled' });
    await AccountDeletionRequest.updateMany(
      { status: 'processing', processingStartedAt: { $lt: staleBefore } },
      { $set: { status: 'scheduled', deleteAt: new Date() }, $unset: { processingStartedAt: 1 } },
    );

    while (true) {
      const request = await AccountDeletionRequest.findOneAndUpdate(
        { status: 'scheduled', deleteAt: { $lte: new Date() } },
        {
          $set: { status: 'processing', processingStartedAt: new Date() },
          $inc: { attempts: 1 },
        },
        { sort: { deleteAt: 1 }, returnDocument: 'after' },
      );
      if (!request) break;

      try {
        await deleteAccountData(request);
        await AccountDeletionRequest.deleteOne({ _id: request._id, status: 'processing' });
        console.info('[ACCOUNT_DELETION_COMPLETED]', String(request._id));
      } catch (error) {
        await AccountDeletionRequest.updateOne(
          { _id: request._id, status: 'processing' },
          {
            $set: {
              status: 'scheduled',
              deleteAt: new Date(Date.now() + RETRY_DELAY_MS),
              lastErrorCode: error?.code || error?.name || 'DELETION_FAILED',
            },
            $unset: { processingStartedAt: 1 },
          },
        );
        console.error('[ACCOUNT_DELETION_RETRY_SCHEDULED]', error?.code || error?.name || 'DELETION_FAILED');
      }
    }
  } catch (error) {
    console.error('[ACCOUNT_DELETION_WORKER_FAILED]', error?.code || error?.name || 'database');
  } finally {
    workerRunning = false;
  }
}

function startAccountDeletionWorker() {
  if (workerTimer) return;
  workerTimer = setInterval(() => { void runDeletionWorker(); }, 60 * 1000);
  workerTimer.unref?.();
  void runDeletionWorker();
}

function stopAccountDeletionWorker() {
  if (!workerTimer) return;
  clearInterval(workerTimer);
  workerTimer = null;
}

module.exports = {
  beginSecureAction,
  completeSecureAction,
  getAccountDeletionStatus,
  cancelAccountDeletion,
  cancelDeletionAfterLogin,
  startAccountDeletionWorker,
  stopAccountDeletionWorker,
  runDeletionWorker,
};
