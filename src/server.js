const createApp = require('./app');
const connectDB = require('./db/connect');
const { env } = require('./config/env');

// Suppress non-error console output when configured (removes noisy logs)
if (env.silenceConsole) {
  try {
    console.log = () => {};
    console.info = () => {};
    console.warn = () => {};
  } catch (e) {
    // ignore if console can't be reassigned
  }
}

async function startServer() {
  const dbConnected = await connectDB();

  if (!dbConnected) {
    console.warn('Proceeding without MongoDB. Memory routes may be unavailable.');
  }

  const app = createApp();
  const port = env.port || 4000;

  app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
