import Registration from '../models/Registration.js';
import AppError from '../utils/AppError.js';
import { getOwned } from './event.service.js';

// Marks a ticket as used. The conditional update means a QR code can only be scanned once.
async function checkIn(eventId, user, qrToken) {
  const event = await getOwned(eventId, user);
  const reg = await Registration.findOneAndUpdate(
    { event: event._id, qrToken, status: 'confirmed' },
    { status: 'checked-in', checkedInAt: new Date() },
    { new: true }
  )
    .populate('user', 'name email')
    .populate('ticketType', 'name kind');
  if (reg) return reg;

  const existing = await Registration.findOne({ event: event._id, qrToken }, 'status checkedInAt');
  if (existing && existing.status === 'checked-in') {
    throw AppError.conflict('TICKET_ALREADY_USED', `Ticket was already used at ${existing.checkedInAt.toISOString()}`);
  }
  throw AppError.notFound('Ticket');
}

export { checkIn };
export default { checkIn };
