import { api, createUser, setupEvent, paidTicket, mockPaystack } from '../helpers.js';
import email from '../../src/services/email.service.js';
import Registration from '../../src/models/Registration.js';
import TicketType from '../../src/models/TicketType.js';
import Payment from '../../src/models/Payment.js';
import Transaction from '../../src/models/Transaction.js';

const buy = (who, event, ticket, quantity) =>
  api().post(`/api/v1/events/${event._id}/register`).set(who.auth).send({ ticketTypeId: String(ticket._id), quantity });
const payDemo = (reference, outcome = 'success') =>
  api().post(`/api/v1/payments/demo/checkout/${encodeURIComponent(reference)}/complete`).send({ outcome });

describe('buying several tickets in one order', () => {
  it('free: one order, one QR code per ticket, one email with every code', async () => {
    const { event, ticket } = await setupEvent();
    const att = await createUser('attendee');
    const res = await buy(att, event, ticket, 3);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ quantity: 3, status: 'confirmed' });
    expect(res.body.data.tickets).toHaveLength(3);
    const codes = res.body.data.tickets.map((t) => t.qrToken);
    expect(new Set(codes).size).toBe(3);
    expect(res.body.data.qrToken).toBe(codes[0]); // single-ticket fields still describe the first ticket
    expect((await TicketType.findById(ticket._id)).sold).toBe(3);
    expect(await Registration.countDocuments({ order: res.body.data.orderId })).toBe(3);

    await email.flush();
    const mails = email.testOutbox.filter((m) => m.to === att.user.email && /ticket/i.test(m.subject));
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe(`Your 3 tickets: ${event.title}`);
    expect(mails[0].attachments.map((a) => a.cid)).toEqual(['ticket-qr-1', 'ticket-qr-2', 'ticket-qr-3']);
  });

  it('each ticket checks in on its own QR code, once', async () => {
    const { organizer, event, ticket } = await setupEvent();
    const att = await createUser('attendee');
    const { body } = await buy(att, event, ticket, 2);
    const url = `/api/v1/events/${event._id}/check-in`;
    for (const t of body.data.tickets) {
      await api().post(url).set(organizer.auth).send({ qrToken: t.qrToken }).expect(200);
    }
    expect((await api().post(url).set(organizer.auth).send({ qrToken: body.data.tickets[0].qrToken })).status).toBe(409);
  });

  it('caps an order at 10 tickets', async () => {
    const { event, ticket } = await setupEvent({ ticket: { quantity: 50 } });
    const att = await createUser('attendee');
    const res = await buy(att, event, ticket, 11);
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('quantity');
    expect((await buy(att, event, ticket, 0)).status).toBe(400);
  });

  it('is all-or-nothing: asking for more than are left takes none and says how many remain', async () => {
    const { event, ticket } = await setupEvent({ ticket: { quantity: 2 } });
    const att = await createUser('attendee');
    const res = await buy(att, event, ticket, 3);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'NOT_ENOUGH_TICKETS', message: 'Only 2 General tickets are left' });
    expect((await TicketType.findById(ticket._id)).sold).toBe(0);
    expect(await Registration.countDocuments()).toBe(0);
  });

  it('joins the waitlist with every ticket when the tier is sold out', async () => {
    const { event, ticket } = await setupEvent({ ticket: { quantity: 1, sold: 1 } });
    const att = await createUser('attendee');
    const res = await buy(att, event, ticket, 2);
    expect(res.status).toBe(202);
    expect(await Registration.countDocuments({ user: att.user._id, status: 'waitlisted' })).toBe(2);
  });

  it('never oversells when two people order the last seats at once', async () => {
    const { event, ticket } = await setupEvent({ ticket: { quantity: 3 } });
    const [a, b] = await Promise.all([createUser(), createUser()]);
    const results = await Promise.all([buy(a, event, ticket, 2), buy(b, event, ticket, 2)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await TicketType.findById(ticket._id)).sold).toBe(2);
  });
});

describe('paid orders', () => {
  async function paidOrder(quantity = 3, eventOverrides = {}) {
    const paystack = mockPaystack();
    const { organizer, event, ticket } = await setupEvent({ ticket: paidTicket(), event: eventOverrides });
    const att = await createUser('attendee');
    const res = await buy(att, event, ticket, quantity);
    const payment = await Payment.findOne({ registration: res.body.data.registrationId });
    return { ...paystack, organizer, event, ticket, att, res, payment };
  }

  it('charges once for the whole order and confirms every ticket on payment', async () => {
    const { res, payment, organizer } = await paidOrder(3);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'pending', quantity: 3, checkoutUrl: expect.any(String) });
    expect(payment).toMatchObject({ amount: 1500000, unitAmount: 500000, quantity: 3, platformFee: 75000, organizerNet: 1425000 });
    expect(payment.registrations).toHaveLength(3);

    const paid = await payDemo(payment.reference);
    expect(paid.status).toBe(200);
    expect(await Registration.countDocuments({ _id: { $in: payment.registrations }, status: 'confirmed' })).toBe(3);

    const ledger = await Transaction.find({}).sort({ createdAt: 1 }).lean();
    expect(ledger.map((t) => [t.type, t.status, t.amount])).toEqual([
      ['ticket_payment', 'success', 1500000],
      ['commission', 'success', 75000],
    ]);
    expect(String(ledger[1].user)).toBe(String(organizer.user._id));
  });

  it('cancelling one paid ticket refunds only its share', async () => {
    const { payment, att, organizer, event, refund } = await paidOrder(3, { refundPolicy: 'full' });
    await payDemo(payment.reference);
    const [one, two, three] = payment.registrations;

    await api().delete(`/api/v1/registrations/${one}`).set(att.auth).expect(200);
    expect(refund).toHaveBeenLastCalledWith(payment.reference, 500000);
    let fresh = await Payment.findById(payment._id);
    expect(fresh).toMatchObject({ status: 'success', refundedAmount: 500000, platformFee: 50000, organizerNet: 950000 });
    expect(await Registration.countDocuments({ _id: { $in: [two, three] }, status: 'confirmed' })).toBe(2);

    const stats = await api().get(`/api/v1/events/${event._id}/stats`).set(organizer.auth);
    expect(stats.body.data.finance[0]).toMatchObject({ gross: 1000000, platformFee: 50000, organizerNet: 950000, refunded: 500000 });
    expect(stats.body.data.revenue).toEqual([{ currency: 'NGN', amount: 1000000 }]);

    const ledger = await Transaction.find({ type: { $in: ['refund', 'commission'] } }).sort({ createdAt: 1 }).lean();
    expect(ledger.map((t) => [t.type, t.status, t.amount])).toEqual([
      ['commission', 'success', 75000],
      ['refund', 'success', 500000],
      ['commission', 'reversed', 25000],
    ]);

    // Refunding the rest closes the payment out.
    await api().delete(`/api/v1/registrations/${two}`).set(att.auth).expect(200);
    await api().delete(`/api/v1/registrations/${three}`).set(att.auth).expect(200);
    fresh = await Payment.findById(payment._id);
    expect(fresh).toMatchObject({ status: 'refunded', refundedAmount: 1500000, platformFee: 0, organizerNet: 0 });
  });

  it('cancelling an unpaid ticket cancels the whole unpaid order and frees every seat', async () => {
    const { res, ticket, att } = await paidOrder(3);
    await api().delete(`/api/v1/registrations/${res.body.data.registrationId}`).set(att.auth).expect(200);
    expect(await Registration.countDocuments({ order: res.body.data.orderId, status: 'cancelled' })).toBe(3);
    expect((await TicketType.findById(ticket._id)).sold).toBe(0);
  });

  it('a declined payment cancels every ticket of the order', async () => {
    const { payment, ticket } = await paidOrder(2);
    await payDemo(payment.reference, 'failed');
    expect(await Registration.countDocuments({ _id: { $in: payment.registrations }, status: 'cancelled' })).toBe(2);
    expect((await TicketType.findById(ticket._id)).sold).toBe(0);
  });

  it('resuming checkout from any ticket of the order reuses the same payment', async () => {
    const { res, payment, att } = await paidOrder(2);
    const third = res.body.data.registrationIds[1];
    const init = await api().post('/api/v1/payments/initialize').set(att.auth).send({ registrationId: third });
    expect(init.body.data.reference).toBe(payment.reference);
  });
});
