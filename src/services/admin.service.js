import User from '../models/User.js';
import Event from '../models/Event.js';
import AppError from '../utils/AppError.js';
import { escapeRegex } from '../utils/http.js';
import { cancelEvent, setPublished } from './event.service.js';

async function listUsers({ page, limit, skip, role, q }) {
  const filter = {};
  if (role) filter.role = role;
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ name: rx }, { email: rx }];
  }
  const [items, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);
  return { items, total, page, limit };
}

const ADMIN = { role: 'admin' };

// Admin moderation of any event. Goes through the same rules organizers face:
// publishing needs tickets, unpublishing needs no registrations, cancelling refunds everyone.
async function setEventStatus(eventId, status) {
  const event = await Event.findById(eventId);
  if (!event) throw AppError.notFound('Event');

  if (event.status === 'completed' && status !== 'completed') {
    throw AppError.conflict('EVENT_CLOSED', 'A completed event cannot be changed');
  }
  // Repeating "cancelled" resumes a cancellation that failed part-way.
  if (status === 'cancelled') return cancelEvent(event);
  if (event.status === status) return event;
  if (['cancelled', 'completed'].includes(event.status)) {
    throw AppError.conflict('EVENT_CLOSED', `A ${event.status} event cannot be reopened`);
  }
  if (status === 'published' || status === 'draft') return setPublished(event._id, ADMIN, status === 'published');

  // status === 'completed'
  event.status = 'completed';
  return event.save();
}

export { listUsers, setEventStatus };
export default { listUsers, setEventStatus };
