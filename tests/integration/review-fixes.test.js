import { jest } from '@jest/globals';
// Regression tests for issues found in code review.
import { api, createUser, createTicket, setupEvent, paidTicket, mockPaystack, sendWebhook, HOUR } from '../helpers.js';
import Registration from '../../src/models/Registration.js';
import TicketType from '../../src/models/TicketType.js';
import Payment from '../../src/models/Payment.js';
import Event from '../../src/models/Event.js';
import payments from '../../src/services/payment.service.js';
import { expireHolds } from '../../src/jobs/index.js';

const register = (who, event, ticket) =>
  api().post(`/api/v1/events/${event._id}/register`).set(who.auth).send({ ticketTypeId: String(ticket._id) });
const expireHoldOf = (registrationId) =>
  Registration.updateOne({ _id: registrationId }, { holdExpiresAt: new Date(Date.now() - 1000) }).then(() => expireHolds());
const charge = (p) => ({ event: 'charge.success', data: { reference: p.reference, amount: p.amount, currency: p.currency } });

describe('stale checkout after re-registration', () => {
  it('does not reuse or honour a checkout made for a different ticket type', async () => {
    const { refund } = mockPaystack();
    const { event, ticket: vip } = await setupEvent({ ticket: paidTicket({ price: 5000000 }) });
    const regular = await createTicket(event, { name: 'Regular', kind: 'regular', price: 1000000 });
    const att = await createUser('attendee');

    const first = await register(att, event, vip).expect(201);
    const regId = first.body.data.registrationId;
    const vipPayment = await Payment.findOne({ registration: regId });
    await expireHoldOf(regId);

    await register(att, event, regular).expect(201);
    const init = await api().post('/api/v1/payments/initialize').set(att.auth).send({ registrationId: regId });
    expect(init.body.data.reference).not.toBe(vipPayment.reference);

    // Paying the abandoned VIP link must not confirm the Regular registration.
    const res = await sendWebhook(charge(vipPayment));
    expect(res.body.data).toEqual({ refunded: true });
    expect(refund).toHaveBeenCalledWith(vipPayment.reference);
    expect((await Registration.findById(regId)).status).toBe('pending');
  });
});

describe('late payment for a cancelled event', () => {
  it('refunds instead of reclaiming a seat', async () => {
    const { refund } = mockPaystack();
    const { organizer, event, ticket } = await setupEvent({ ticket: paidTicket() });
    const att = await createUser('attendee');
    const { body } = await register(att, event, ticket);
    const payment = await Payment.findOne({ registration: body.data.registrationId });
    await expireHoldOf(body.data.registrationId);
    await api().delete(`/api/v1/events/${event._id}`).set(organizer.auth).expect(200);

    const res = await sendWebhook(charge(payment));
    expect(res.body.data).toEqual({ refunded: true });
    expect(refund).toHaveBeenCalledWith(payment.reference);
    expect((await Registration.findById(body.data.registrationId)).status).toBe('cancelled');
    expect((await TicketType.findById(ticket._id)).sold).toBe(0);
  });
});

describe('event cancellation can be resumed', () => {
  it('a failed run reports an error and retrying DELETE finishes the job', async () => {
    mockPaystack();
    const { organizer, event, ticket } = await setupEvent({ ticket: paidTicket() });
    const [a, b] = await Promise.all([createUser(), createUser()]);
    for (const u of [a, b]) {
      const reg = await Registration.create({ event: event._id, user: u.user._id, ticketType: ticket._id, status: 'confirmed', qrToken: String(u.user._id).padEnd(64, '0') });
      await Payment.create({ registration: reg._id, event: event._id, ticketType: ticket._id, reference: `P-${u.user._id}`, amount: 500000, status: 'success' });
    }
    const spy = jest.spyOn(payments, 'refundSuccessfulPayments').mockRejectedValueOnce(new Error('db blip'));

    const first = await api().delete(`/api/v1/events/${event._id}`).set(organizer.auth);
    expect(first.status).toBe(500);
    expect(first.body.error.code).toBe('CANCELLATION_INCOMPLETE');
    expect((await Event.findById(event._id)).status).toBe('cancelled');

    spy.mockRestore();
    const retry = await api().delete(`/api/v1/events/${event._id}`).set(organizer.auth);
    expect(retry.status).toBe(200);
    expect(await Registration.countDocuments({ event: event._id, status: { $ne: 'cancelled' } })).toBe(0);
    // The registration whose refund failed was cancelled on the first run, so the retry refunds the rest.
    expect(await Payment.countDocuments({ status: 'refunded' })).toBeGreaterThanOrEqual(1);
  });
});

describe('admin status changes follow the event rules', () => {
  it('blocks unpublishing with registrations, reopening completed events and publishing without tickets', async () => {
    const admin = await createUser('admin');
    const { event, ticket } = await setupEvent();
    const att = await createUser('attendee');
    await register(att, event, ticket).expect(201);
    const set = (id, status) => api().patch(`/api/v1/admin/events/${id}/status`).set(admin.auth).send({ status });

    expect((await set(event._id, 'draft')).body.error.code).toBe('HAS_REGISTRATIONS');
    expect((await set(event._id, 'completed')).body.data.status).toBe('completed');
    expect((await set(event._id, 'published')).body.error.code).toBe('EVENT_CLOSED');
    expect((await set(event._id, 'cancelled')).body.error.code).toBe('EVENT_CLOSED');

    const bare = await Event.create({ ...event.toObject(), _id: undefined, slug: 'bare', status: 'draft' });
    expect((await set(bare._id, 'published')).body.error.code).toBe('NO_TICKETS');
  });
});

describe('raising ticket quantity', () => {
  it('promotes waitlisted users into the new seats first', async () => {
    const { organizer, event, ticket } = await setupEvent({ ticket: { quantity: 1 } });
    const [a, b, c] = await Promise.all([createUser(), createUser(), createUser()]);
    await register(a, event, ticket).expect(201);
    await register(b, event, ticket).expect(202);
    await register(c, event, ticket).expect(202);

    const res = await api().patch(`/api/v1/tickets/${ticket._id}`).set(organizer.auth).send({ quantity: 2 });
    expect(res.body.data.sold).toBe(2);
    expect((await Registration.findOne({ user: b.user._id })).status).toBe('confirmed');
    expect((await Registration.findOne({ user: c.user._id })).status).toBe('waitlisted');
  });
});

describe('event date edits', () => {
  it('rejects an endAt before ticket sales close, and resets reminders when startAt moves', async () => {
    const { organizer, event, ticket } = await setupEvent();
    const tooEarly = new Date(ticket.saleEnd.getTime() - HOUR);
    const bad = await api()
      .patch(`/api/v1/events/${event._id}`)
      .set(organizer.auth)
      .send({ startAt: new Date(tooEarly.getTime() - 2 * HOUR), endAt: tooEarly });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0].field).toBe('endAt');

    const att = await createUser('attendee');
    await register(att, event, ticket);
    await Registration.updateMany({}, { reminderSentAt: new Date() });
    await api()
      .patch(`/api/v1/events/${event._id}`)
      .set(organizer.auth)
      .send({ startAt: new Date(event.startAt.getTime() + HOUR) })
      .expect(200);
    expect((await Registration.findOne({ user: att.user._id })).reminderSentAt).toBeUndefined();

    const past = await api().patch(`/api/v1/events/${event._id}`).set(organizer.auth).send({ startAt: new Date(Date.now() - HOUR) });
    expect(past.status).toBe(400);
  });
});

describe('expireHolds waitlist sweep', () => {
  it('promotes waitlisted users when seats are free even if no hold expired this run', async () => {
    const { event, ticket } = await setupEvent({ ticket: { quantity: 1 } });
    const att = await createUser('attendee');
    await Registration.create({ event: event._id, user: att.user._id, ticketType: ticket._id, status: 'waitlisted', waitlistedAt: new Date() });
    expect(await expireHolds()).toBe(0);
    expect((await Registration.findOne({ user: att.user._id })).status).toBe('confirmed');
  });
});
