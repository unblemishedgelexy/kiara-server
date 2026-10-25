const createApp = require('./app');
const connectDB = require('./db/connect');
const { env, validateProductionConfig } = require('./config/env');
const promotionWorker = require('./services/memory/promotion/promotionWorker');
const WorkingMemoryRedis = require('./services/workingMemory/redisOperations');
const { ensureSubscriptionIndexes } = require('./services/subscriptions/subscriptionIndexes');
const MemoryService = require('./services/memory');
const redisService = require('./services/infrastructure/redisService');
const mongoose = require('mongoose');
const accountDeletionService = require('./services/accountDeletionService');

async function startServer() {
  validateProductionConfig();
  const dbConnected = await connectDB();

  if (!dbConnected) {
    console.error('[STARTUP_DEPENDENCY_UNAVAILABLE]', 'mongodb');
  } else {
    await ensureSubscriptionIndexes();
  }

  try {
    await redisService.initRedis();
  } catch (error) {
    console.error('[STARTUP_DEPENDENCY_UNAVAILABLE]', 'redis', error?.code || error?.name || 'connection_failed');
  }

  const memoryEnabled = Boolean(env.liveMemoryEnabled);
  const promotionWorkerEnabled = memoryEnabled && env.enablePinecone && env.enablePromotionWorker;

  if (promotionWorkerEnabled) {
    promotionWorker.startPromotionWorker();
  }

  WorkingMemoryRedis.startRejectedMemoryCleanupScheduler();
  accountDeletionService.startAccountDeletionWorker();

  const app = createApp();
  const port = env.port || 4000;

  const server = app.listen(port);
  server.requestTimeout = 15 * 60 * 1000;
  server.once('listening', () => {
    const address = server.address();
    const listenUrl = address && typeof address === 'object'
      ? `http://localhost:${address.port}`
      : `http://localhost:${port}`;
    console.log('[SERVER]', 'Server started');
    console.log('[SERVER]', `Listening at ${listenUrl}`);
  });

  let shutdownPromise = null;
  const shutdown = (signal) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const forceExit = setTimeout(() => {
        console.error('[SERVER_SHUTDOWN]', 'Graceful shutdown timed out.');
        process.exit(1);
      }, 15000);

      promotionWorker.stopPromotionWorker();
      WorkingMemoryRedis.stopRejectedMemoryCleanupScheduler();
      accountDeletionService.stopAccountDeletionWorker();

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
  console.error('[STARTUP_FAILED]', error?.name || error?.code || 'StartupError');
  process.exit(1);
});
