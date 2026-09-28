const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const controller = require('../controllers/subscriptionController');

const router = express.Router();

router.get('/plans', controller.getPlans);
router.post('/webhook/razorpay', controller.razorpayWebhook);

router.use(authMiddleware);
router.get('/me', controller.getAccount);
router.post('/checkout', controller.createCheckout);
router.post('/verify', controller.verifyCheckout);
router.post('/cancel', controller.cancelSubscription);
router.post('/usage/chat/reserve', controller.reserveChatMessage);
router.post('/usage/chat/commit', controller.commitChatMessage);
router.post('/usage/chat/release', controller.releaseChatMessage);
router.post('/usage/live/heartbeat', controller.heartbeatLive);
router.get('/usage/live/active', controller.getActiveLive);
router.post('/usage/live/end', controller.endLive);

module.exports = router;