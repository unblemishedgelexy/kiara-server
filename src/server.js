const createApp = require('./app');
const connectDB = require('./db/connect');
const startupValidationService = require('./services/memory/startupValidationService');
const { env } = require('./config/env');
// V7: User isolation audit
const { auditCrossUserReferences } = require('./services/memory/userIsolationValidator');

// // Suppress non-error console output when configured (removes noisy logs)
// if (env.silenceConsole) {
//   try {
//     console.log = () => {};
//     console.info = () => {};
//     console.warn = () => {};
//   } catch (e) {
//     // ignore if console can't be reassigned
//   }
// }

async function startServer() {
  const dbConnected = await connectDB();

  if (!dbConnected) {
    console.warn('Proceeding without MongoDB. Memory routes may be unavailable.');
  }

  if (env.enableMemoryStartupValidation !== 'false') {
    try {
      const result = await startupValidationService.runStartupChecks();
      if (result && result.ok) {
        console.log('[V65_MEMORY_OK]');
      } else {
        console.warn('[V65_MEMORY_FAIL]', result);
      }
    } catch (error) {
      console.error('[V65_MEMORY_FAIL] startup validation error', error);
    }
  }

  // V7: User isolation audit
  if (env.enableUserIsolationAudit !== 'false') {
    try {
      const auditResult = await auditCrossUserReferences();
      if (auditResult && auditResult.ok) {
        console.log('[V7_ISOLATION_OK]');
      } else {
        console.warn('[V7_ISOLATION_FAIL]', auditResult);
      }
    } catch (error) {
      console.error('[V7_ISOLATION_FAIL] audit error', error);
    }
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
