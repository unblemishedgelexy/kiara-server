const createApp = require('./app');
const connectDB = require('./db/connect');
const { env } = require('./config/env');
const promotionWorker = require('./services/memory/promotion/promotionWorker');
const WorkingMemoryRedis = require('./services/workingMemory/redisOperations');

async function startServer() {
  const dbConnected = await connectDB();

  if (!dbConnected) {
    console.error('[ERROR]', 'Proceeding without MongoDB. Profile and auth routes may be unavailable.');
  }

  const memoryEnabled = Boolean(env.liveMemoryEnabled);
  const promotionWorkerEnabled = memoryEnabled && env.enablePinecone && env.enablePromotionWorker;
  if (promotionWorkerEnabled) {
    promotionWorker.startPromotionWorker();
  }

  WorkingMemoryRedis.startRejectedMemoryCleanupScheduler();

  console.log('[SERVER_START]', 'Server ready.');

  const app = createApp();
  const port = env.port || 4000;

  app.listen(port, () => {
    console.log('[SERVER_START]', `http://localhost:${port}`);
  });
}

startServer().catch((error) => {
  console.error('[ERROR]', 'Failed to start server:', error instanceof Error ? error.message : error);
  process.exit(1);
});
