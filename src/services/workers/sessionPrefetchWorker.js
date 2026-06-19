const continuityRestorationService = require('../memory/continuityRestorationService');
const bootstrapCacheService = require('../memory/bootstrapCacheService');
const sessionMemoryService = require('../memory/sessionMemoryService');

let running = false;

async function checkAndPrefetch() {
  try {
    const keys = await sessionMemoryService.listActiveSessions().catch(() => []);
    for (const userId of keys) {
      const active = await sessionMemoryService.getActiveSessionMemory(userId).catch(() => null);
      const expiresAt = active && active.expiresAt ? new Date(active.expiresAt) : null;
      if (!expiresAt) continue;
      const ttl = (expiresAt.getTime() - Date.now()) / 1000;
      if (ttl < 60) {
        const packet = await continuityRestorationService.buildContinuityPacket(userId, { tokenBudget: 512 }).catch(() => null);
        if (packet && bootstrapCacheService && typeof bootstrapCacheService.cacheBootstrapContext === 'function') {
          await bootstrapCacheService.cacheBootstrapContext(userId, packet.bootstrap).catch(() => null);
        }
      }
    }
  } catch (e) {
    console.warn('sessionPrefetchWorker error', e);
  }
}

function start(intervalMs = 15000) {
  if (running) return;
  running = true;
  setInterval(checkAndPrefetch, intervalMs);
}

module.exports = { start };
