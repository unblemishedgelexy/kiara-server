const tokenMap = new Map();

function saveTokenMapping(tokenName, userId, expireTime) {
  try {
    tokenMap.set(tokenName, { userId: String(userId), expireTime: new Date(expireTime).toISOString() });
  } catch (e) {
    // ignore
  }
}

function getUserForToken(tokenName) {
  const entry = tokenMap.get(tokenName);
  if (!entry) return null;
  // remove if expired
  if (entry.expireTime && new Date(entry.expireTime).getTime() < Date.now()) {
    tokenMap.delete(tokenName);
    return null;
  }
  return entry.userId || null;
}

function cleanupExpired() {
  const now = Date.now();
  for (const [k, v] of tokenMap.entries()) {
    if (v.expireTime && new Date(v.expireTime).getTime() < now) {
      tokenMap.delete(k);
    }
  }
}

module.exports = { saveTokenMapping, getUserForToken, cleanupExpired };
