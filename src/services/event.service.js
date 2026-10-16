import slugify from 'slugify';
import Event from '../models/Event.js';
import TicketType from '../models/TicketType.js';
import Registration from '../models/Registration.js';
import { ACTIVE_STATUSES } from '../models/Registration.js';
import logger from '../config/logger.js';
import AppError from '../utils/AppError.js';
import { escapeRegex } from '../utils/http.js';
import { randomToken } from '../utils/tokens.js';
import { withTransaction } from '../utils/transaction.js';
import { assertOwner, isOwnerOrAdmin } from './access.js';
import { cancelRegistration, allocatedQuantity } from './inventory.service.js';
import payments from './payment.service.js';
import notify from './notification.service.js';
import { uploadBanner } from './upload.service.js';

const ACTIVE = ACTIVE_STATUSES;

async function uniqueSlug(title) {
  const base = slugify(title, { lower: true, strict: true }).slice(0, 80) || 'event';
  if (!(await Event.exists({ slug: base }))) return base;
  return `${base}-${randomToken(3)}`;
}

async function getOwned(eventId, user) {
  const event = await Event.findById(eventId);
  if (!event) throw AppError.notFound('Event');
  assertOwner(event, user);
  return event;
}

function assertEditable(event) {
  if (['cancelled', 'completed'].includes(event.status)) {
    throw AppError.conflict('EVENT_CLOSED', `A ${event.status} event cannot be changed`);
  }
}

async function create(organizerId, data) {
  const slug = await uniqueSlug(data.title);
  return Event.create({ ...data, organizer: organizerId, slug, status: 'draft' });
}

const invalid = (field, message) => AppError.badRequest('VALIDATION_ERROR', message, [{ field, message }]);

async function update(eventId, user, data) {
  const event = await getOwned(eventId, user);
  assertEditable(event);
  const startAt = data.startAt ?? event.startAt;
  const endAt = data.endAt ?? event.endAt;
  if (endAt <= startAt) throw invalid('endAt', 'endAt must be after startAt');
  if (data.startAt && data.startAt <= new Date()) throw invalid('startAt', 'startAt must be in the future');
  if (data.endAt) {
    const lastSale = await TicketType.findOne({ event: event._id }, 'saleEnd').sort({ saleEnd: -1 });
    if (lastSale && endAt < lastSale.saleEnd) {
      throw invalid('endAt', 'endAt cannot be before a ticket sale window ends');
    }
  }
  if (data.capacity !== undefined) {
    const total = await allocatedQuantity(event._id);
    if (data.capacity < total) {
      throw AppError.conflict('CAPACITY_TOO_LOW', `Capacity cannot be below the ${total} tickets already defined`);
    }
  }
  const moved = data.startAt && data.startAt.getTime() !== event.startAt.getTime();
  Object.assign(event, data);
  const saved = await event.save();
  // A new start time needs a new 24-hour reminder.
  if (moved) await Registration.updateMany({ event: event._id }, { $unset: { reminderSentAt: 1 } });
  return saved;
}

async function setPublished(eventId, user, publish) {
  const event = await getOwned(eventId, user);
  assertEditable(event);
  if (publish) {
    if (event.endAt <= new Date()) throw AppError.conflict('EVENT_ENDED', 'An event that has ended cannot be published');
    if (!(await TicketType.exists({ event: event._id }))) {
      throw AppError.conflict('NO_TICKETS', 'Add at least one ticket type before publishing');
    }
    event.status = 'published';
  } else {
    if (await Registration.exists({ event: event._id, status: { $in: ACTIVE } })) {
      throw AppError.conflict('HAS_REGISTRATIONS', 'Events with registrations cannot be unpublished; cancel it instead');
    }
    event.status = 'draft';
  }
  return event.save();
}

// Cancels an event, cancelling every active registration and refunding paid ones.
// Safe to call again: it only touches registrations that are still active, so a run
// that failed part-way can be resumed by repeating DELETE (or the admin status change).
async function cancelEvent(event) {
  if (event.status !== 'cancelled') {
    event.status = 'cancelled'; // set first so no new registrations slip in
    await event.save();
  }
  const regs = await Registration.find({ event: event._id, status: { $in: ACTIVE } }, '_id');
  let failed = 0;
  for (const { _id } of regs) {
    try {
      const before = await withTransaction((session) =>
        cancelRegistration({ _id }, ACTIVE, 'event_cancelled', session)
      );
      if (!before) continue;
      if (['confirmed', 'checked-in'].includes(before.status)) await payments.refundSuccessfulPayments(_id);
      await notify.cancelled(_id, 'the event was cancelled');
    } catch (err) {
      failed += 1;
      logger.error({ err, registrationId: _id, eventId: event._id }, 'Failed to cancel registration for cancelled event');
    }
  }
  if (failed) {
    throw new AppError(500, 'CANCELLATION_INCOMPLETE', `${failed} registrations could not be cancelled; retry the request`);
  }
  return event;
}

// DELETE /events/:id: hard-deletes an event nobody registered for, otherwise cancels it.
async function remove(eventId, user) {
  const event = await getOwned(eventId, user);
  if (!(await Registration.exists({ event: event._id }))) {
    await TicketType.deleteMany({ event: event._id });
    await event.deleteOne();
    return { deleted: true };
  }
  if (event.status === 'completed') throw AppError.conflict('EVENT_CLOSED', 'A completed event cannot be cancelled');
  return { cancelled: true, event: await cancelEvent(event) };
}

async function setBanner(eventId, user, file) {
  const event = await getOwned(eventId, user);
  if (!file) throw AppError.badRequest('VALIDATION_ERROR', 'A banner image file is required');
  event.bannerUrl = await uploadBanner(file.buffer, String(event._id));
  return event.save();
}

const PUBLIC_TICKET_FIELDS = 'name kind price currency quantity sold saleStart saleEnd';

// Public view by slug. Drafts are visible only to their organizer or an admin.
async function getBySlug(slug, viewer) {
  const event = await Event.findOne({ slug }).populate('organizer', 'name');
  if (!event) throw AppError.notFound('Event');
  const visible = event.status !== 'draft' || (viewer && isOwnerOrAdmin({ organizer: event.organizer._id }, viewer));
  if (!visible) throw AppError.notFound('Event');
  const tickets = await TicketType.find({ event: event._id }, PUBLIC_TICKET_FIELDS).sort({ price: 1 });
  return {
    ...event.toObject(),
    ticketTypes: tickets.map((t) => ({ ...t.toObject(), available: Math.max(0, t.quantity - t.sold) })),
  };
}


async function search(query, { limit, skip }, sort) {
  const filter = { status: 'published' };
  if (query.q) filter.$text = { $search: query.q };
  if (query.category) filter.category = query.category.toLowerCase();
  if (query.city) filter['venue.city'] = new RegExp(`^${escapeRegex(query.city)}$`, 'i');
  if (query.from || query.to) {
    filter.startAt = {};
    if (query.from) filter.startAt.$gte = query.from;
    if (query.to) filter.startAt.$lte = query.to;
  } else {
    // when: upcoming (default) = not started yet; live = started and not ended;
    // current = live + upcoming (anything not over yet).
    const now = new Date();
    if (query.when === 'live') {
      filter.startAt = { $lte: now };
      filter.endAt = { $gt: now };
    } else if (query.when === 'current') {
      filter.endAt = { $gt: now };
    } else {
      filter.startAt = { $gte: now };
    }
  }
  if (query.isFree !== undefined || query.minPrice !== undefined || query.maxPrice !== undefined) {
    const price = {};
    if (query.isFree === true) price.$eq = 0;
    if (query.isFree === false) price.$gt = 0;
    if (query.minPrice !== undefined) price.$gte = query.minPrice;
    if (query.maxPrice !== undefined) price.$lte = query.maxPrice;
    filter._id = { $in: await TicketType.distinct('event', { price }) };
  }

  const [items, total] = await Promise.all([
    Event.find(filter).sort(sort).skip(skip).limit(limit).populate('organizer', 'name'),
    Event.countDocuments(filter),
  ]);
  return { items, total };
}

// Dashboard buckets. A published event whose endAt has passed counts as completed even
// before the hourly closeEvents job flips its status.
function bucketFilter(bucket, now) {
  switch (bucket) {
    case 'live':
      return { status: 'published', endAt: { $gt: now } };
    case 'completed':
      return { $or: [{ status: 'completed' }, { status: 'published', endAt: { $lte: now } }] };
    case 'draft':
    case 'cancelled':
      return { status: bucket };
    default:
      return {};
  }
}

// GET /me/events: an organizer's own events in every status (admins see all events),
// plus counts for the dashboard cards.
async function listForOwner(user, { limit, skip, bucket, q }, now = new Date()) {
  const scope = user.role === 'admin' ? {} : { organizer: user.id };
  if (q) scope.title = new RegExp(escapeRegex(q), 'i');
  const filter = { ...scope, ...bucketFilter(bucket, now) };

  const [items, total, counts] = await Promise.all([
    Event.find(filter).sort({ startAt: -1 }).skip(skip).limit(limit).populate('organizer', 'name').lean(),
    Event.countDocuments(filter),
    Promise.all(['live', 'draft', 'completed', 'cancelled'].map((b) => Event.countDocuments({ ...scope, ...bucketFilter(b, now) }))),
  ]);

  // Ticket figures for the cards: lowest price, tickets sold, tickets available.
  const tickets = await TicketType.find({ event: { $in: items.map((e) => e._id) } }, 'event price quantity sold').lean();
  const byEvent = new Map();
  for (const t of tickets) {
    const key = String(t.event);
    const agg = byEvent.get(key) || { minPrice: null, ticketsSold: 0, ticketsTotal: 0, ticketTypes: 0 };
    agg.minPrice = agg.minPrice === null ? t.price : Math.min(agg.minPrice, t.price);
    agg.ticketsSold += t.sold;
    agg.ticketsTotal += t.quantity;
    agg.ticketTypes += 1;
    byEvent.set(key, agg);
  }

  const [live, draft, completed, cancelled] = counts;
  return {
    items: items.map((e) => ({ ...e, ...(byEvent.get(String(e._id)) || { minPrice: null, ticketsSold: 0, ticketsTotal: 0, ticketTypes: 0 }) })),
    total,
    summary: { total: await Event.countDocuments(scope), live, draft, completed, cancelled },
  };
}

export { create, update, setPublished, remove, cancelEvent, setBanner, getBySlug, search, listForOwner, getOwned, assertEditable };
export default { create, update, setPublished, remove, cancelEvent, setBanner, getBySlug, search, listForOwner, getOwned, assertEditable };
