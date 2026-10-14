import env from '../config/env.js';
import logger from '../config/logger.js';
import Event from '../models/Event.js';
import Registration from '../models/Registration.js';
import TicketType from '../models/TicketType.js';
import { withTransaction } from '../utils/transaction.js';
import { claimSeat } from './inventory.service.js';
import { newQrToken } from './qr.service.js';
import notify from './notification.service.js';
// payment.service imports this module too; only used inside functions, so the cycle is safe.
import payments from './payment.service.js';

class RaceError extends Error {}

// Promotes the oldest waitlisted registrations for a ticket type while seats are free.
// Free tickets are confirmed straight away. Paid tickets get a new hold and checkout link.
async function promoteNext(ticketTypeId) {
  const promoted = [];
  for (;;) {
    const ticket = await TicketType.findById(ticketTypeId);
    if (!ticket || ticket.sold >= ticket.quantity) break;
    const event = await Event.findById(ticket.event, 'status startAt');
    if (!event || event.status !== 'published' || event.startAt <= new Date()) break;

    const isFree = ticket.price === 0;
    let reg;
    try {
      reg = await withTransaction(async (session) => {
        const next = await Registration.findOne({ ticketType: ticketTypeId, status: 'waitlisted' })
          .sort({ waitlistedAt: 1, _id: 1 })
          .session(session);
        if (!next) return null;
        if (!(await claimSeat(ticketTypeId, session))) return null;
        const set = isFree
          ? { status: 'confirmed', qrToken: newQrToken() }
          : { status: 'pending', holdExpiresAt: new Date(Date.now() + env.HOLD_MINUTES * 60 * 1000) };
        const updated = await Registration.findOneAndUpdate(
          { _id: next._id, status: 'waitlisted' },
          { $set: set, $unset: { waitlistedAt: 1 } },
          { new: true, session }
        );
        if (!updated) throw new RaceError(); // aborts the transaction, so the seat claim is rolled back
        return updated;
      });
    } catch (err) {
      if (err instanceof RaceError) continue;
      throw err;
    }
    if (!reg) break;
    promoted.push(reg);

    if (isFree) {
      await notify.ticket(reg._id);
    } else {
      try {
        const { checkoutUrl } = await payments.startCheckout(reg._id);
        await notify.paymentRequired(reg._id, checkoutUrl);
      } catch (err) {
        // The hold expires on its own and the seat goes to the next person.
        logger.error({ err, registrationId: reg._id }, 'Could not start checkout for promoted registration');
      }
    }
  }
  return promoted;
}

export { promoteNext };
export default { promoteNext };
