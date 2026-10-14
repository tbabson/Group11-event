import Registration from '../models/Registration.js';
import Payment from '../models/Payment.js';
import TicketType from '../models/TicketType.js';
import { csvRow } from '../utils/csv.js';
import { getOwned } from './event.service.js';
import { eventFinance } from './payout.service.js';

async function attendees(eventId, user, { limit, skip, status }) {
  const event = await getOwned(eventId, user);
  const filter = { event: event._id };
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    Registration.find(filter, '-qrToken')
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .populate('user', 'name email')
      .populate('ticketType', 'name kind price'),
    Registration.countDocuments(filter),
  ]);
  return { items, total };
}

async function stats(eventId, user) {
  const event = await getOwned(eventId, user);
  const [byStatus, revenueRows, tickets] = await Promise.all([
    Registration.aggregate([{ $match: { event: event._id } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Payment.aggregate([
      { $match: { event: event._id, status: 'success' } },
      { $group: { _id: '$currency', amount: { $sum: '$amount' } } },
    ]),
    TicketType.find({ event: event._id }, 'name kind price quantity sold'),
  ]);

  const finance = await eventFinance(event);
  const counts = { pending: 0, confirmed: 0, waitlisted: 0, cancelled: 0, 'checked-in': 0 };
  for (const row of byStatus) counts[row._id] = row.count;
  const attending = counts.confirmed + counts['checked-in'];

  return {
    eventId: event._id,
    capacity: event.capacity,
    registrations: { ...counts, total: Object.values(counts).reduce((a, b) => a + b, 0) },
    revenue: revenueRows.map((r) => ({ currency: r._id, amount: r.amount })),
    checkInRate: attending ? Number((counts['checked-in'] / attending).toFixed(4)) : 0,
    finance,
    ticketTypes: tickets.map((t) => ({
      id: t._id,
      name: t.name,
      kind: t.kind,
      price: t.price,
      quantity: t.quantity,
      sold: t.sold,
    })),
  };
}

const CSV_HEADER = ['Name', 'Email', 'Ticket', 'Status', 'Registered At', 'Checked In At'];

// Streams the attendee list as CSV rows to `write`, one registration at a time.
async function writeAttendeesCsv(eventId, user, write) {
  const event = await getOwned(eventId, user);
  write(`${csvRow(CSV_HEADER)}\n`);
  const cursor = Registration.find({ event: event._id, status: { $ne: 'cancelled' } })
    .sort({ createdAt: 1 })
    .populate('user', 'name email')
    .populate('ticketType', 'name')
    .cursor();
  for await (const r of cursor) {
    write(`${csvRow([r.user?.name, r.user?.email, r.ticketType?.name, r.status, r.createdAt, r.checkedInAt])}\n`);
  }
  return event;
}

export { attendees, stats, writeAttendeesCsv };
export default { attendees, stats, writeAttendeesCsv };
