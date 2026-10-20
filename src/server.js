const createApp = require('./app');
const connectDB = require('./db/connect');
const { env } = require('./config/env');
const promotionWorker = require('./services/memory/promotion/promotionWorker');
const WorkingMemoryRedis = require('./services/workingMemory/redisOperations');
const { ensureSubscriptionIndexes } = require('./services/subscriptions/subscriptionIndexes');
const MemoryService = require('./services/memory');
const redisService = require('./services/infrastructure/redisService');
const mongoose = require('mongoose');

async function startServer() {
  const dbConnected = await connectDB();

  if (!dbConnected) {
    console.error('[ERROR]', 'Proceeding without MongoDB. Profile and auth routes may be unavailable.');
  } else {
    await ensureSubscriptionIndexes();
  }

  const memoryEnabled = Boolean(env.liveMemoryEnabled);
  const promotionWorkerEnabled = memoryEnabled && env.enablePinecone && env.enablePromotionWorker;

  console.log('[MEMORY_SYSTEM]', JSON.stringify({
    enabled: memoryEnabled,
    mode: memoryEnabled ? 'enabled' : 'disabled-during-live-stability',
    promotionWorkerEnabled,
    timestamp: new Date().toISOString(),
  }));

  if (promotionWorkerEnabled) {
    promotionWorker.startPromotionWorker();
  }

  WorkingMemoryRedis.startRejectedMemoryCleanupScheduler();

  console.log('[SERVER_START]', 'Server ready.');

  const app = createApp();
  const port = env.port || 4000;

  const server = app.listen(port, () => {
    console.log('[SERVER_START]', `http://localhost:${port}`);
  });
  server.requestTimeout = 15 * 60 * 1000;

  let shutdownPromise = null;
  const shutdown = (signal) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      console.info('[SERVER_SHUTDOWN]', JSON.stringify({ signal }));
      const forceExit = setTimeout(() => {
        console.error('[SERVER_SHUTDOWN]', 'Graceful shutdown timed out.');
        process.exit(1);
      }, 15000);

      promotionWorker.stopPromotionWorker();
      WorkingMemoryRedis.stopRejectedMemoryCleanupScheduler();

      const serverClosed = new Promise((resolve) => server.close(resolve));
      const memoryDrain = MemoryService.drainCanonicalWriteJobs(8000);
      const [drainResult] = await Promise.all([
        memoryDrain,
        serverClosed,
      ]);
      if (!drainResult.drained) {
        console.warn('[SERVER_SHUTDOWN]', JSON.stringify({
          pendingCanonicalMemoryWrites: drainResult.pending,
        }));
      }

      await Promise.allSettled([
        redisService.closeRedis(),
        mongoose.disconnect(),
      ]);
      clearTimeout(forceExit);
    })().catch((error) => {
      console.error('[SERVER_SHUTDOWN]', error?.name || 'shutdown_error');
      process.exitCode = 1;
    });
    return shutdownPromise;
  };

  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
}

startServer().catch((error) => {
  console.error('[ERROR]', 'Failed to start server:', error instanceof Error ? error.message : error);
  process.exit(1);
});
