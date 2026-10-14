import cron from 'node-cron';
import logger from '../config/logger.js';
import email from '../services/email.service.js';
import expireHolds from './expireHolds.js';
import eventReminders from './eventReminders.js';
import closeEvents from './closeEvents.js';
import { releaseDuePayouts } from '../services/payout.service.js';

// Wraps a job so a run never overlaps the previous one and errors are logged, not thrown.
function guarded(name, fn) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      const result = await fn();
      if (result) logger.info({ job: name, result }, 'Job finished');
    } catch (err) {
      logger.error({ err, job: name }, 'Job failed');
    } finally {
      running = false;
    }
  };
}

function startJobs() {
  const tasks = [
    cron.schedule('* * * * *', guarded('expireHolds', () => expireHolds())),
    cron.schedule('0 * * * *', guarded('eventReminders', () => eventReminders())),
    cron.schedule('5 * * * *', guarded('closeEvents', () => closeEvents())),
    cron.schedule('15 * * * *', guarded('releasePayouts', () => releaseDuePayouts())),
    cron.schedule('*/10 * * * * *', guarded('emailQueue', () => email.flush())),
  ];
  logger.debug('Background jobs scheduled');
  return () => tasks.forEach((t) => t.stop());
}

export { startJobs, expireHolds, eventReminders, closeEvents, releaseDuePayouts };
export default { startJobs, expireHolds, eventReminders, closeEvents, releaseDuePayouts };
