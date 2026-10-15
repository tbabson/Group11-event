import mongoose from 'mongoose';
import env from '../config/env.js';
import Event from '../models/Event.js';
import TicketType from '../models/TicketType.js';
import Registration from '../models/Registration.js';
import AppError from '../utils/AppError.js';
import { withTransaction } from '../utils/transaction.js';
import { claimSeats, cancelRegistration, HOLDS_SEAT } from './inventory.service.js';
import { newQrToken, qrPng } from './qr.service.js';
import { isOwnerOrAdmin } from './access.js';
import payments from './payment.service.js';
import waitlist from './waitlist.service.js';
import notify from './notification.service.js';

function assertRegistrable(event, ticket, now) {
  if (event.status !== 'published' || event.startAt <= now) {
    throw AppError.conflict('EVENT_NOT_OPEN', 'This event is not open for registration');
  }
  if (now < ticket.saleStart || now > ticket.saleEnd) {
    throw AppError.conflict('SALE_CLOSED', `${ticket.name} tickets are not on sale right now`);
  }
}

// Buys `quantity` tickets of one type in a single order. Each ticket is its own registration
// (one seat, one QR code); the same person can place further orders later.
// Seats are claimed all-or-nothing: if fewer are left than asked for, nothing is taken.
// Returns { registrations, checkoutUrl?, httpStatus }.
async function register(userId, eventId, ticketTypeId, quantity = 1) {
  const now = new Date();
  if (quantity > env.MAX_TICKETS_PER_ORDER) {
    throw AppError.badRequest('VALIDATION_ERROR', `You can buy at most ${env.MAX_TICKETS_PER_ORDER} tickets per order`, [
      { field: 'quantity', message: `must be at most ${env.MAX_TICKETS_PER_ORDER}` },
    ]);
  }
  const event = await Event.findById(eventId);
  if (!event) throw AppError.notFound('Event');
  const ticket = await TicketType.findOne({ _id: ticketTypeId, event: event._id });
  if (!ticket) throw AppError.notFound('Ticket type');
  assertRegistrable(event, ticket, now);
  const isFree = ticket.price === 0;
  const order = new mongoose.Types.ObjectId();

  const registrations = await withTransaction(async (session) => {
    let fields;
    if (await claimSeats(ticket._id, quantity, session)) {
      fields = isFree
        ? () => ({ status: 'confirmed', qrToken: newQrToken() })
        : () => ({ status: 'pending', holdExpiresAt: new Date(now.getTime() + env.HOLD_MINUTES * 60 * 1000) });
    } else {
      const current = await TicketType.findById(ticket._id, 'sold quantity').session(session);
      const left = Math.max(0, current.quantity - current.sold);
      if (left > 0) {
        throw AppError.conflict('NOT_ENOUGH_TICKETS', `Only ${left} ${ticket.name} ${left === 1 ? 'ticket is' : 'tickets are'} left`);
      }
      fields = () => ({ status: 'waitlisted', waitlistedAt: now }); // sold out: join the waitlist
    }
    const docs = Array.from({ length: quantity }, () => ({ event: event._id, user: userId, ticketType: ticket._id, order, ...fields() }));
    return Registration.create(docs, { session, ordered: true });
  });

  const ids = registrations.map((r) => r._id);
  const [first] = registrations;
  if (first.status === 'waitlisted') {
    await notify.waitlisted(first._id);
    return { registrations, httpStatus: 202 };
  }
  if (first.status === 'confirmed') {
    await notify.tickets(ids);
    return { registrations, httpStatus: 201 };
  }

  // Paid: the seats are held while the attendee pays for the whole order in one checkout.
  try {
    const { checkoutUrl } = await payments.startCheckout(ids);
    return { registrations, checkoutUrl, httpStatus: 201 };
  } catch (err) {
    for (const id of ids) {
      await withTransaction((session) => cancelRegistration({ _id: id }, ['pending'], 'payment_failed', session));
    }
    await waitlist.promoteNext(ticket._id);
    throw err;
  }
}

// DELETE /registrations/:id. Attendees cancel their own, and organizers can cancel any on their event.
async function cancel(user, registrationId) {
  const reg = await Registration.findById(registrationId).populate('event', 'organizer startAt refundPolicy');
  if (!reg) throw AppError.notFound('Registration');
  const isAttendee = String(reg.user) === String(user.id);
  const isOrganizer = isOwnerOrAdmin(reg.event, user);
  if (!isAttendee && !isOrganizer) throw AppError.notFound('Registration');
  if (reg.event.startAt <= new Date()) {
    throw AppError.conflict('EVENT_STARTED', 'Registrations cannot be cancelled after the event starts');
  }

  const reason = isAttendee ? 'user' : 'organizer';
  const before = await withTransaction((session) =>
    cancelRegistration({ _id: reg._id }, ['pending', 'confirmed', 'waitlisted'], reason, session)
  );
  if (!before) throw AppError.conflict('CANNOT_CANCEL', `A ${reg.status} registration cannot be cancelled`);

  // Unpaid tickets of an order share one checkout, so the rest of the unpaid order goes too.
  if (before.status === 'pending' && before.order) {
    const siblings = await Registration.find({ order: before.order, status: 'pending', _id: { $ne: before._id } }, '_id');
    for (const s of siblings) {
      await withTransaction((session) => cancelRegistration({ _id: s._id }, ['pending'], reason, session));
    }
  }

  if (before.status === 'confirmed' && (reg.event.refundPolicy === 'full' || !isAttendee)) {
    await payments.refundSuccessfulPayments(reg._id);
  }
  await notify.cancelled(reg._id, isAttendee ? null : 'cancelled by the organizer');
  if (HOLDS_SEAT.includes(before.status)) await waitlist.promoteNext(before.ticketType);

  return Registration.findById(reg._id);
}

async function listForUser(userId, { limit, skip, status }) {
  const filter = { user: userId };
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    Registration.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('event', 'title slug startAt endAt status venue onlineUrl bannerUrl')
      .populate('ticketType', 'name kind price currency'),
    Registration.countDocuments(filter),
  ]);
  return { items, total };
}

// Ticket QR code as a PNG, for the attendee (or the event's organizer / an admin).
// Only confirmed and checked-in registrations have a valid QR token.
async function ticketQr(user, registrationId, size) {
  const reg = await Registration.findById(registrationId).populate('event', 'organizer slug');
  const allowed = reg && (String(reg.user) === String(user.id) || isOwnerOrAdmin(reg.event, user));
  if (!allowed) throw AppError.notFound('Registration');
  if (!reg.qrToken || !['confirmed', 'checked-in'].includes(reg.status)) {
    throw AppError.conflict('NO_TICKET', `A ${reg.status} registration has no ticket QR code`);
  }
  return {
    png: await qrPng(reg.qrToken, size),
    filename: `ticket-${reg.event.slug}-${reg._id}.png`,
  };
}

export { register, cancel, listForUser, ticketQr };
export default { register, cancel, listForUser, ticketQr };
