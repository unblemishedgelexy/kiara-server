const SupportRequest = require('../models/SupportRequest');

const SESSION_FEEDBACK_SUBJECTS = ['Kiara session feedback', 'Kiara session issue report'];
const SESSION_FEEDBACK_LIVE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function validateSupportRequest(body) {
  const subject = typeof body?.subject === 'string' ? body.subject.trim() : '';
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  const rating = body?.rating;

  if (subject.length < 1 || subject.length > 120) {
    return { valid: false, message: 'Subject must be between 1 and 120 characters.' };
  }
  if (message.length < 10 || message.length > 3000) {
    return { valid: false, message: 'Message must be between 10 and 3000 characters.' };
  }
  if (rating !== undefined && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    return { valid: false, message: 'Rating must be an integer between 1 and 5.' };
  }
  return rating === undefined
    ? { valid: true, subject, message }
    : { valid: true, subject, message, rating };
}

function isSessionFeedbackSubject(subject) {
  return SESSION_FEEDBACK_SUBJECTS.some(
    (knownSubject) => knownSubject.toLowerCase() === subject.toLowerCase(),
  );
}

async function hasSessionFeedback(userId) {
  return Boolean(await SupportRequest.exists({
    userId,
    $or: [
      { type: 'session_feedback' },
      { subject: { $in: SESSION_FEEDBACK_SUBJECTS } },
    ],
  }));
}

async function getSessionFeedbackBlockStatus(userId, now = Date.now()) {
  const feedback = await SupportRequest.findOne({
    userId,
    $or: [
      { type: 'session_feedback' },
      { subject: { $in: SESSION_FEEDBACK_SUBJECTS } },
    ],
  }).sort({ createdAt: -1 }).select({ createdAt: 1 }).lean();

  if (!feedback) {
    return { submitted: false, blockedUntil: null };
  }

  const deadline = new Date(feedback.createdAt).getTime() + SESSION_FEEDBACK_LIVE_COOLDOWN_MS;
  return {
    submitted: true,
    blockedUntil: deadline > now ? new Date(deadline).toISOString() : null,
  };
}

async function getSessionFeedbackStatus(req, res, next) {
  try {
    const status = await getSessionFeedbackBlockStatus(req.userId);
    return res.json({ success: true, data: status });
  } catch (error) {
    return next(error);
  }
}

async function createSupportRequest(req, res, next) {
  const validated = validateSupportRequest(req.body);
  if (!validated.valid) {
    return res.status(400).json({ success: false, message: validated.message });
  }

  try {
    const isSessionFeedback = isSessionFeedbackSubject(validated.subject);
    if (isSessionFeedback && await hasSessionFeedback(req.userId)) {
      const status = await getSessionFeedbackBlockStatus(req.userId);
      return res.status(200).json({
        success: true,
        data: { alreadySubmitted: true, blockedUntil: status.blockedUntil },
      });
    }

    const supportRequest = await SupportRequest.create({
      userId: req.userId,
      subject: validated.subject,
      message: validated.message,
      ...(validated.rating === undefined ? {} : { rating: validated.rating }),
      ...(isSessionFeedback ? { type: 'session_feedback' } : {}),
    });
    return res.status(201).json({
      success: true,
      data: {
        requestId: supportRequest.id,
        blockedUntil: new Date(
          new Date(supportRequest.createdAt).getTime() + SESSION_FEEDBACK_LIVE_COOLDOWN_MS,
        ).toISOString(),
      },
    });
  } catch (error) {
    if (
      error?.code === 11000
      && isSessionFeedbackSubject(validated.subject)
    ) {
      const status = await getSessionFeedbackBlockStatus(req.userId);
      return res.status(200).json({
        success: true,
        data: { alreadySubmitted: true, blockedUntil: status.blockedUntil },
      });
    }
    return next(error);
  }
}

module.exports = {
  createSupportRequest,
  getSessionFeedbackBlockStatus,
  getSessionFeedbackStatus,
  hasSessionFeedback,
  isSessionFeedbackSubject,
  validateSupportRequest,
};
