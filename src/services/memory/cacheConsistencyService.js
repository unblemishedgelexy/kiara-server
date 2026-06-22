const bootstrapCacheService = require('./bootstrapCacheService');
const sessionContinuityCacheService = require('./sessionContinuityCacheService');
const { ensureUserId } = require('../../utils/ensureUserId');

async function invalidateUserCaches(userId) {
  ensureUserId(userId);
  await Promise.all([
    sessionContinuityCacheService.invalidateContinuityCache(userId),
    bootstrapCacheService.deleteBootstrapContext(userId),
  ]).catch((err) => {
    console.error('Error invalidating user caches:', err);
  });
}

async function rebuildUserCaches(userId) {
  ensureUserId(userId);
  await Promise.all([
    sessionContinuityCacheService.refreshContinuityCache(userId),
    (async () => {
      const sessionBootstrapService = require('./sessionBootstrapService');
      return sessionBootstrapService.buildSessionBootstrapContext(userId, true).catch((err) => {
        console.error('Error rebuilding bootstrap cache during rebuildUserCaches:', err);
        return null;
      });
    })(),
  ]).catch((err) => {
    console.error('Error rebuilding user caches:', err);
  });
}

async function verifyCacheFreshness(userId) {
  ensureUserId(userId);
  const continuity = await sessionContinuityCacheService.getContinuityCache(userId);
  const bootstrap = await bootstrapCacheService.getBootstrapContext(userId);
  return {
    userId,
    continuityCacheExists: Boolean(continuity),
    bootstrapCacheExists: Boolean(bootstrap),
    continuityAgeMs: continuity ? Date.now() - new Date(continuity.cacheGeneratedAt).getTime() : null,
    bootstrapAgeMs: bootstrap ? Date.now() - new Date(bootstrap.lastUpdated).getTime() : null,
    valid: Boolean(continuity) && Boolean(bootstrap),
  };
}

module.exports = {
  invalidateUserCaches,
  rebuildUserCaches,
  verifyCacheFreshness,
};