function ensureUserId(userId) {
  if (!userId || typeof userId !== 'string' || !userId.trim()) {
    throw new Error('userId is required for this operation');
  }
  return userId.trim();
}

module.exports = { ensureUserId };
