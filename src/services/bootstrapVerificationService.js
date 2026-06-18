const { env } = require('../config/env');
const bootstrapCacheService = require('./bootstrapCacheService');
const sessionBootstrapService = require('./sessionBootstrapService');

async function verifyBootstrapVersion(userId) {
  const cached = await bootstrapCacheService.getBootstrapContext(userId);
  return cached ? cached.bootstrapVersion === env.bootstrapVersion : false;
}

async function verifyBootstrapInjection(userId, injectionMetadata = {}) {
  const cached = await bootstrapCacheService.getBootstrapContext(userId);
  if (!cached) return { bootstrapLoaded: false, bootstrapInjected: false };
  return {
    bootstrapLoaded: true,
    bootstrapInjected: Boolean(injectionMetadata.injectedAt),
    bootstrapVersion: cached.bootstrapVersion,
    bootstrapSize: Buffer.byteLength(JSON.stringify(cached), 'utf8'),
    injectionLatency: injectionMetadata.injectedAt && injectionMetadata.requestedAt ?
      new Date(injectionMetadata.injectedAt).getTime() - new Date(injectionMetadata.requestedAt).getTime() :
      null,
  };
}

async function verifySessionPrimed(userId) {
  const cached = await bootstrapCacheService.getBootstrapContext(userId);
  return {
    sessionPrimed: Boolean(cached && cached.bootstrapContext),
    bootstrapVersion: cached?.bootstrapVersion || null,
  };
}

module.exports = {
  verifyBootstrapInjection,
  verifySessionPrimed,
  verifyBootstrapVersion,
};