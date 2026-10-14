import logger from '../config/logger.js';
import Registration from '../models/Registration.js';
import { withTransaction } from '../utils/transaction.js';
import { cancelRegistration } from '../services/inventory.service.js';
import { promoteNext } from '../services/waitlist.service.js';
import notify from '../services/notification.service.js';

// Cancels pending registrations whose payment hold has run out, frees the seats and
// promotes the waitlist. Returns how many holds were released.
async function expireHolds(now = new Date()) {
  const expired = await Registration.find({ status: 'pending', holdExpiresAt: { $lte: now } }, '_id ticketType');
  let released = 0;
  for (const reg of expired) {
    const before = await withTransaction((session) =>
      cancelRegistration({ _id: reg._id, holdExpiresAt: { $lte: now } }, ['pending'], 'hold_expired', session)
    );
    if (!before) continue; // paid or cancelled in the meantime
    released += 1;
    await notify.cancelled(before._id, 'payment was not completed in time');
  }

  // Promote every ticket type that has people waiting, not just the ones freed above.
  // That way a promotion that failed on an earlier run is retried on this one.
  const waiting = await Registration.distinct('ticketType', { status: 'waitlisted' });
  for (const ticketTypeId of waiting) {
    try {
      await promoteNext(ticketTypeId);
    } catch (err) {
      logger.error({ err, ticketTypeId }, 'Waitlist promotion failed; will retry next run');
    }
  }
  return released;
}

export default expireHolds;
