const { ensureUserId } = require('../../utils/ensureUserId');

function validateSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error('sessionId is required and must be a non-empty string');
  }
  return sessionId.trim();
}

function validateUserId(userId) {
  return ensureUserId(userId);
}

function validateMemoryOperation({ userId, sessionId }) {
  const safeUserId = validateUserId(userId);
  const safeSessionId = sessionId ? validateSessionId(sessionId) : null;
  return { userId: safeUserId, sessionId: safeSessionId };
}

module.exports = {
  validateUserId,
  validateSessionId,
  validateMemoryOperation,
};
