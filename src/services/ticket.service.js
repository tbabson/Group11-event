import TicketType from '../models/TicketType.js';
import AppError from '../utils/AppError.js';
import Event from '../models/Event.js';
import { assertOwner } from './access.js';
import { getOwned, assertEditable } from './event.service.js';
import { allocatedQuantity } from './inventory.service.js';
import { promoteNext } from './waitlist.service.js';

function assertPriceMatchesKind(kind, price) {
  if (kind === 'free' && price !== 0) {
    throw AppError.badRequest('VALIDATION_ERROR', 'Free tickets must have a price of 0', [
      { field: 'price', message: 'must be 0 for free tickets' },
    ]);
  }
  if (kind !== 'free' && !(price > 0)) {
    throw AppError.badRequest('VALIDATION_ERROR', 'Paid tickets need a price above 0', [
      { field: 'price', message: 'must be greater than 0' },
    ]);
  }
}

function assertSaleWindow(saleStart, saleEnd, event) {
  if (saleEnd <= saleStart) {
    throw AppError.badRequest('VALIDATION_ERROR', 'saleEnd must be after saleStart', [
      { field: 'saleEnd', message: 'must be after saleStart' },
    ]);
  }
  if (saleEnd > event.endAt) {
    throw AppError.badRequest('VALIDATION_ERROR', 'Ticket sales must end before the event ends', [
      { field: 'saleEnd', message: 'must be before the event ends' },
    ]);
  }
}

async function create(eventId, user, data) {
  const event = await getOwned(eventId, user);
  assertEditable(event);
  const price = data.kind === 'free' ? data.price ?? 0 : data.price;
  assertPriceMatchesKind(data.kind, price);
  const saleStart = data.saleStart ?? new Date();
  const saleEnd = data.saleEnd ?? event.startAt;
  assertSaleWindow(saleStart, saleEnd, event);
  if ((await allocatedQuantity(event._id)) + data.quantity > event.capacity) {
    throw AppError.conflict('CAPACITY_EXCEEDED', 'Ticket quantities would exceed the event capacity');
  }
  return TicketType.create({ ...data, price, saleStart, saleEnd, event: event._id });
}

async function update(ticketId, user, data) {
  const ticket = await TicketType.findById(ticketId);
  if (!ticket) throw AppError.notFound('Ticket type');
  const event = await Event.findById(ticket.event);
  assertOwner(event, user);
  assertEditable(event);

  if (data.quantity !== undefined) {
    if (data.quantity < ticket.sold) {
      throw AppError.conflict('QUANTITY_TOO_LOW', `${ticket.sold} tickets are already sold`);
    }
    if ((await allocatedQuantity(event._id, ticket._id)) + data.quantity > event.capacity) {
      throw AppError.conflict('CAPACITY_EXCEEDED', 'Ticket quantities would exceed the event capacity');
    }
  }
  if ((data.price !== undefined || data.kind !== undefined) && ticket.sold > 0) {
    throw AppError.conflict('TICKETS_SOLD', 'Price and kind cannot change after tickets are sold');
  }
  const next = { ...ticket.toObject(), ...data };
  assertPriceMatchesKind(next.kind, next.price);
  assertSaleWindow(next.saleStart, next.saleEnd, event);

  // Quantity is set with a guard so a concurrent sale can't push sold above quantity.
  const updated = await TicketType.findOneAndUpdate(
    data.quantity !== undefined ? { _id: ticket._id, sold: { $lte: data.quantity } } : { _id: ticket._id },
    { $set: data },
    { new: true, runValidators: true }
  );
  if (!updated) throw AppError.conflict('QUANTITY_TOO_LOW', 'More tickets were sold than the new quantity');
  // New seats go to people already waiting before anyone else can grab them.
  if (data.quantity !== undefined && data.quantity > ticket.quantity) {
    await promoteNext(updated._id);
    return TicketType.findById(updated._id);
  }
  return updated;
}

export { create, update };
export default { create, update };
