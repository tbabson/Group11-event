import env from './config/env.js';
import logger from './config/logger.js';
import { connectDB, disconnectDB } from './config/db.js';
import createApp from './app.js';
import { startJobs } from './jobs/index.js';
import email from './services/email.service.js';

async function main() {
  await connectDB(env.MONGODB_URI);
  const app = createApp();
  const stopJobs = startJobs();
  const server = app.listen(env.PORT, () => {
    const mail = env.BREVO_API_KEY ? 'brevo' : env.SMTP_HOST ? 'smtp' : 'log only';
    logger.info(
      `API ready on ${env.APP_URL} · docs ${env.APP_URL}/api/docs · paystack ${env.PAYSTACK_MODE} · email ${mail}`
    );
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutting down');
    stopJobs();
    server.close();
    await email.flush().catch(() => { });
    await disconnectDB();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
