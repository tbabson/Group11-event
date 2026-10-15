// Seat accounting. Every change to TicketType.sold goes through here.
import TicketType from '../models/TicketType.js';
import Registration from '../models/Registration.js';

// Atomically takes `count` seats, all or nothing. Returns the updated ticket type, or null
// when fewer than `count` are left. The sold + count <= quantity condition is what stops
// two buyers taking the last seat.
function claimSeats(ticketTypeId, count, session) {
  return TicketType.findOneAndUpdate(
    { _id: ticketTypeId, $expr: { $lte: [{ $add: ['$sold', count] }, '$quantity'] } },
    { $inc: { sold: count } },
    { new: true, session }
  );
}

const claimSeat = (ticketTypeId, session) => claimSeats(ticketTypeId, 1, session);

function releaseSeat(ticketTypeId, session) {
  return TicketType.updateOne({ _id: ticketTypeId, sold: { $gt: 0 } }, { $inc: { sold: -1 } }, { session });
}

const HOLDS_SEAT = ['pending', 'confirmed'];

// Cancels a registration if it is currently in one of `fromStatuses`, releasing its
// seat in the same transaction. Returns the registration as it was before, or null
// if it was not in an allowed status (someone else got there first).
async function cancelRegistration(filter, fromStatuses, reason, session) {
  const before = await Registration.findOneAndUpdate(
    { ...filter, status: { $in: fromStatuses } },
    {
      $set: { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason },
      $unset: { holdExpiresAt: 1, qrToken: 1, waitlistedAt: 1 },
    },
    { new: false, session }
  );
  if (before && HOLDS_SEAT.includes(before.status)) {
    await releaseSeat(before.ticketType, session);
  }
  return before;
}

// Total ticket quantity defined for an event, optionally ignoring one ticket type.
async function allocatedQuantity(eventId, excludeTicketId) {
  const match = { event: eventId };
  if (excludeTicketId) match._id = { $ne: excludeTicketId };
  const [{ total = 0 } = {}] = await TicketType.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$quantity' } } },
  ]);
  return total;
}

export { claimSeat, claimSeats, releaseSeat, cancelRegistration, allocatedQuantity, HOLDS_SEAT };
export default { claimSeat, claimSeats, releaseSeat, cancelRegistration, allocatedQuantity, HOLDS_SEAT };
