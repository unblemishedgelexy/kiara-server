const accountDeletionService = require('../services/accountDeletionService');

function handleSecureActionError(error, res, next) {
  const statuses = {
    ACCOUNT_DELETION_ALREADY_SCHEDULED: 409,
    SECURE_ACTION_PASSWORD_REQUIRED: 400,
    SECURE_ACTION_PASSWORD_INVALID: 401,
    SECURE_ACTION_OTP_INVALID: 400,
    SECURE_ACTION_ACCOUNT_UNAVAILABLE: 403,
    ACCOUNT_DELETION_FINALIZED: 403,
    OTP_RATE_LIMITED: 429,
    OTP_DELIVERY_FAILED: 503,
    ACCOUNT_MEMORY_DELETE_INCOMPLETE: 503,
  };
  const status = statuses[error.code];
  if (!status) return next(error);
  return res.status(status).json({ success: false, code: error.code, message: error.message });
}

async function requestDeletion(req, res, next) {
  try {
    const result = req.body?.code
      ? await accountDeletionService.completeSecureAction(req.userId, 'account_deletion', req.body.code)
      : await accountDeletionService.beginSecureAction(
        req.userId,
        'account_deletion',
        req.body?.password,
        { ipAddress: req.ip, userAgent: req.headers['user-agent'] },
      );
    return res.status(req.body?.code ? 200 : 202).json(result);
  } catch (error) {
    return handleSecureActionError(error, res, next);
  }
}

async function requestMemoryDeletion(req, res, next) {
  try {
    const result = req.body?.code
      ? await accountDeletionService.completeSecureAction(req.userId, 'memory_deletion', req.body.code)
      : await accountDeletionService.beginSecureAction(
        req.userId,
        'memory_deletion',
        req.body?.password,
        { ipAddress: req.ip, userAgent: req.headers['user-agent'] },
      );
    return res.status(req.body?.code ? 200 : 202).json(result);
  } catch (error) {
    return handleSecureActionError(error, res, next);
  }
}

async function getDeletionStatus(req, res, next) {
  try {
    return res.json(await accountDeletionService.getAccountDeletionStatus(req.userId));
  } catch (error) {
    return next(error);
  }
}

async function cancelDeletion(req, res, next) {
  try {
    return res.json(await accountDeletionService.cancelAccountDeletion(req.userId));
  } catch (error) {
    return next(error);
  }
}

module.exports = { requestDeletion, requestMemoryDeletion, getDeletionStatus, cancelDeletion };
