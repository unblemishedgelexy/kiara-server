const User = require('../models/User');
const { getPublicPlans } = require('../config/subscriptionPlans');
const subscriptionService = require('../services/subscriptions/subscriptionService');
const usageService = require('../services/subscriptions/usageService');

function sendError(res, error) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  if (statusCode >= 500) {
    console.error('[SUBSCRIPTION_ERROR]', error instanceof Error ? error.message : String(error));
  }
  return res.status(statusCode).json({
    success: false,
    code: error?.code || 'SUBSCRIPTION_REQUEST_FAILED',
    message: error instanceof Error ? error.message : 'Subscription request failed.',
    ...(error?.details ? { details: error.details } : {}),
  });
}

async function getPlans(_req, res) {
  return res.json({ success: true, plans: getPublicPlans(), checkout: subscriptionService.getPublicCheckoutConfig() });
}

async function getAccount(req, res) {
  try {
    return res.json({ success: true, data: await subscriptionService.getAccountOverview(req.userId) });
  } catch (error) {
    return sendError(res, error);
  }
}

async function createCheckout(req, res) {
  try {
    const planId = req.body?.planId;
    if (typeof planId !== 'string') {
      throw subscriptionService.serviceError('A plan must be selected.', 'INVALID_PLAN', 400);
    }
    const user = await User.findById(req.userId).select('email').lean();
    if (!user) throw subscriptionService.serviceError('Account not found.', 'ACCOUNT_NOT_FOUND', 404);
    const data = await subscriptionService.createOrUpdateCheckout(req.userId, planId, user.email);
    return res.status(data.action === 'checkout' ? 201 : 200).json({ success: true, data });
  } catch (error) {
    return sendError(res, error);
  }
}

async function verifyCheckout(req, res) {
  try {
    const { razorpayPaymentId, razorpaySubscriptionId, razorpaySignature } = req.body || {};
    if (![razorpayPaymentId, razorpaySubscriptionId, razorpaySignature].every((value) => typeof value === 'string' && value.trim())) {
      throw subscriptionService.serviceError('Razorpay payment details are incomplete.', 'INVALID_PAYMENT_RESULT', 400);
    }
    const data = await subscriptionService.verifyCheckoutPayment(req.userId, {
      razorpayPaymentId,
      razorpaySubscriptionId,
      razorpaySignature,
    });
    return res.json({ success: true, data });
  } catch (error) {
    return sendError(res, error);
  }
}

async function cancelSubscription(req, res) {
  try {
    const data = await subscriptionService.cancelCurrentSubscription(req.userId);
    return res.json({ success: true, data });
  } catch (error) {
    return sendError(res, error);
  }
}

async function reserveChatMessage(req, res) {
  try {
    return res.json({ success: true, data: await usageService.reserveChatMessage(req.userId) });
  } catch (error) {
    return sendError(res, error);
  }
}

async function commitChatMessage(req, res) {
  try {
    const reservationId = req.body?.reservationId;
    if (typeof reservationId !== 'string' || !reservationId) {
      throw usageService.createUsageError('A usage reservation is required.', 'INVALID_USAGE_RESERVATION', 400);
    }
    return res.json({ success: true, data: await usageService.commitChatMessage(req.userId, reservationId) });
  } catch (error) {
    return sendError(res, error);
  }
}

async function releaseChatMessage(req, res) {
  try {
    const reservationId = req.body?.reservationId;
    if (typeof reservationId !== 'string' || !reservationId) {
      throw usageService.createUsageError('A usage reservation is required.', 'INVALID_USAGE_RESERVATION', 400);
    }
    return res.json({ success: true, data: await usageService.releaseChatReservation(req.userId, reservationId) });
  } catch (error) {
    return sendError(res, error);
  }
}

async function heartbeatLive(req, res) {
  try {
    const sessionId = req.body?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) {
      throw usageService.createUsageError('A live session ID is required.', 'INVALID_LIVE_SESSION', 400);
    }
    return res.json({ success: true, data: await usageService.heartbeatLiveSession(req.userId, sessionId) });
  } catch (error) {
    return sendError(res, error);
  }
}

async function getActiveLive(req, res) {
  try {
    return res.json({ success: true, data: await usageService.getActiveLiveSession(req.userId) });
  } catch (error) {
    return sendError(res, error);
  }
}

async function endLive(req, res) {
  try {
    const sessionId = req.body?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) {
      throw usageService.createUsageError('A live session ID is required.', 'INVALID_LIVE_SESSION', 400);
    }
    return res.json({ success: true, data: await usageService.endLiveSession(req.userId, sessionId) });
  } catch (error) {
    return sendError(res, error);
  }
}

async function razorpayWebhook(req, res) {
  try {
    if (typeof req.rawBody !== 'string' || !req.rawBody) {
      throw subscriptionService.serviceError('Raw webhook body is unavailable.', 'WEBHOOK_BODY_UNAVAILABLE', 400);
    }
    const result = await subscriptionService.processWebhook(
      req.rawBody,
      req.headers['x-razorpay-signature'],
      req.headers['x-razorpay-event-id'],
    );
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error);
  }
}

module.exports = {
  cancelSubscription,
  commitChatMessage,
  createCheckout,
  endLive,
  getAccount,
  getActiveLive,
  getPlans,
  heartbeatLive,
  razorpayWebhook,
  releaseChatMessage,
  reserveChatMessage,
  verifyCheckout,
};