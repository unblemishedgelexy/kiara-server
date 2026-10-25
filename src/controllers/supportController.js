const SupportRequest = require('../models/SupportRequest');

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

async function createSupportRequest(req, res, next) {
  const validated = validateSupportRequest(req.body);
  if (!validated.valid) {
    return res.status(400).json({ success: false, message: validated.message });
  }

  try {
    const supportRequest = await SupportRequest.create({
      userId: req.userId,
      subject: validated.subject,
      message: validated.message,
      ...(validated.rating === undefined ? {} : { rating: validated.rating }),
    });
    return res.status(201).json({
      success: true,
      data: { requestId: supportRequest.id },
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { createSupportRequest, validateSupportRequest };
