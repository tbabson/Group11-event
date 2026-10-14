import env from '../config/env.js';
import Event from '../models/Event.js';
import TicketType from '../models/TicketType.js';
import Registration from '../models/Registration.js';
import AppError from '../utils/AppError.js';
import { withTransaction } from '../utils/transaction.js';
import { claimSeat, cancelRegistration, HOLDS_SEAT } from './inventory.service.js';
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

// Registers a user for an event. Returns { registration, checkoutUrl?, httpStatus }.
async function register(userId, eventId, ticketTypeId) {
  const now = new Date();
  const event = await Event.findById(eventId);
  if (!event) throw AppError.notFound('Event');
  const ticket = await TicketType.findOne({ _id: ticketTypeId, event: event._id });
  if (!ticket) throw AppError.notFound('Ticket type');
  assertRegistrable(event, ticket, now);
  const isFree = ticket.price === 0;

  const registration = await withTransaction(async (session) => {
    const existing = await Registration.findOne({ event: event._id, user: userId }).session(session);
    if (existing && existing.status !== 'cancelled') {
      throw AppError.conflict('ALREADY_REGISTERED', 'You are already registered for this event');
    }

    const seat = await claimSeat(ticket._id, session);
    let fields;
    if (!seat) fields = { status: 'waitlisted', waitlistedAt: now };
    else if (isFree) fields = { status: 'confirmed', qrToken: newQrToken() };
    else fields = { status: 'pending', holdExpiresAt: new Date(now.getTime() + env.HOLD_MINUTES * 60 * 1000) };

    if (existing) {
      // Re-registering after a cancellation reuses the document (event + user is unique).
      // If it stopped being 'cancelled' meanwhile, throwing aborts the transaction and the seat claim.
      const reused = await Registration.findOneAndUpdate(
        { _id: existing._id, status: 'cancelled' },
        {
          $set: { ticketType: ticket._id, ...fields },
          $unset: { cancelledAt: 1, cancelReason: 1, checkedInAt: 1, reminderSentAt: 1 },
        },
        { new: true, session }
      );
      if (!reused) throw AppError.conflict('ALREADY_REGISTERED', 'You are already registered for this event');
      return reused;
    }
    const [created] = await Registration.create(
      [{ event: event._id, user: userId, ticketType: ticket._id, ...fields }],
      { session }
    );
    return created;
  }).catch((err) => {
    if (err && err.code === 11000) {
      throw AppError.conflict('ALREADY_REGISTERED', 'You are already registered for this event');
    }
    throw err;
  });

  if (registration.status === 'waitlisted') {
    await notify.waitlisted(registration._id);
    return { registration, httpStatus: 202 };
  }
  if (registration.status === 'confirmed') {
    await notify.ticket(registration._id);
    return { registration, httpStatus: 201 };
  }

  // Paid: the seat is held while the attendee pays.
  try {
    const { checkoutUrl } = await payments.startCheckout(registration._id);
    return { registration, checkoutUrl, httpStatus: 201 };
  } catch (err) {
    await withTransaction((session) =>
      cancelRegistration({ _id: registration._id }, ['pending'], 'payment_failed', session)
    );
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
