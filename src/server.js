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
    const local = `http://localhost:${env.PORT}`;
    logger.info(`API ready on ${local} · docs ${local}/api/docs · paystack ${env.PAYSTACK_MODE} · email ${mail}`);
    // APP_URL builds the demo checkout links; a stale localhost port would break them.
    const appUrl = new URL(env.APP_URL);
    if (['localhost', '127.0.0.1'].includes(appUrl.hostname) && Number(appUrl.port || 80) !== env.PORT) {
      logger.warn(`APP_URL is ${env.APP_URL} but the API runs on port ${env.PORT}: update APP_URL in .env`);
    }
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
