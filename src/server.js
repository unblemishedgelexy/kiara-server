const createApp = require('./app');
const connectDB = require('./db/connect');
const { env } = require('./config/env');

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
