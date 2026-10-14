import nodemailer from 'nodemailer';
import env from '../config/env.js';
import logger from '../config/logger.js';
import brevo from './brevo.client.js';

// In-process email queue with retries. Good enough for a single instance;
// swap for BullMQ if the API is ever scaled horizontally.
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 10 * 1000;

// Transport priority: Brevo API (BREVO_API_KEY) → plain SMTP (SMTP_HOST, e.g. Brevo's
// smtp-relay.brevo.com) → JSON transport that only logs, for local dev and tests.
let transporter;
function getTransporter() {
  if (transporter) return transporter;
  if (env.BREVO_API_KEY) {
    transporter = brevo;
    return transporter;
  }
  transporter = env.SMTP_HOST
    ? nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      })
    : nodemailer.createTransport({ jsonTransport: true });
  return transporter;
}

const queue = [];
// Messages delivered while NODE_ENV=test, so tests can assert on them.
const testOutbox = [];

function enqueue(message) {
  queue.push({ message: { from: env.MAIL_FROM, ...message }, attempts: 0, nextAttemptAt: 0 });
}

async function deliver(message) {
  await getTransporter().sendMail(message);
  if (env.NODE_ENV === 'test') testOutbox.push(message);
  else logger.info({ to: message.to, subject: message.subject }, 'Email sent');
}

// Sends every message that is due. Failed messages are retried with exponential backoff.
async function flush(now = Date.now()) {
  const due = queue.filter((job) => job.nextAttemptAt <= now);
  for (const job of due) {
    queue.splice(queue.indexOf(job), 1);
    try {
      await deliver(job.message);
    } catch (err) {
      job.attempts += 1;
      if (job.attempts < MAX_ATTEMPTS) {
        job.nextAttemptAt = now + BASE_BACKOFF_MS * 2 ** (job.attempts - 1);
        queue.push(job);
        logger.warn({ err, to: job.message.to, attempt: job.attempts }, 'Email failed, will retry');
      } else {
        logger.error({ err, to: job.message.to }, 'Email failed permanently');
      }
    }
  }
}

// Test hook: swap the transport (pass undefined to reset).
function _setTransporter(t) {
  transporter = t;
}

export { enqueue, flush, queue, testOutbox, _setTransporter };
export default { enqueue, flush, queue, testOutbox, _setTransporter };
