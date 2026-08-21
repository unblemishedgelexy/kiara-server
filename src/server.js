const createApp = require('./app');
const connectDB = require('./db/connect');
const { env } = require('./config/env');
const promotionWorker = require('./services/memory/promotion/promotionWorker');

async function startServer() {
  const dbConnected = await connectDB();

  if (!dbConnected) {
    console.error('[ERROR]', 'Proceeding without MongoDB. Profile and auth routes may be unavailable.');
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
