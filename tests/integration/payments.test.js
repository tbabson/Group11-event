import { api, createUser, setupEvent, paidTicket, mockPaystack, sendWebhook } from '../helpers.js';
import email from '../../src/services/email.service.js';
import Registration from '../../src/models/Registration.js';
import TicketType from '../../src/models/TicketType.js';
import Payment from '../../src/models/Payment.js';
import { expireHolds } from '../../src/jobs/index.js';

async function paidRegistration({ quantity = 5 } = {}) {
  const paystackMocks = mockPaystack();
  const { organizer, event, ticket } = await setupEvent({ ticket: paidTicket({ quantity }) });
  const att = await createUser('attendee');
  const res = await api()
    .post(`/api/v1/events/${event._id}/register`)
    .set(att.auth)
    .send({ ticketTypeId: String(ticket._id) })
    .expect(201);
  const payment = await Payment.findOne({ registration: res.body.data.registrationId });
  return { ...paystackMocks, organizer, event, ticket, att, registrationId: res.body.data.registrationId, payment };
}

const charge = (payment, overrides = {}) => ({
  event: 'charge.success',
  data: { reference: payment.reference, amount: payment.amount, currency: payment.currency, status: 'success', ...overrides },
});

describe('payments webhook', () => {
  it('rejects bad signatures with 401 and changes nothing', async () => {
    const { payment, registrationId } = await paidRegistration();
    const res = await sendWebhook(charge(payment), 'deadbeef');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    expect((await Registration.findById(registrationId)).status).toBe('pending');

    const unsigned = await api().post('/api/v1/payments/webhook').send(charge(payment));
    expect(unsigned.status).toBe(401);
  });

  it('confirms the registration, issues a QR and emails the ticket on success', async () => {
    const { payment, registrationId, att } = await paidRegistration();
    const res = await sendWebhook(charge(payment));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ confirmed: true });

    const reg = await Registration.findById(registrationId);
    expect(reg.status).toBe('confirmed');
    expect(reg.qrToken).toMatch(/^[a-f0-9]{64}$/);
    expect(reg.holdExpiresAt).toBeUndefined();
    expect((await Payment.findById(payment._id)).status).toBe('success');
    await email.flush();
    expect(email.testOutbox.some((m) => m.to === att.user.email && m.subject.startsWith('Your ticket'))).toBe(true);
  });

  it('is idempotent: duplicate webhooks are acknowledged but processed once', async () => {
    const { payment, registrationId } = await paidRegistration();
    await sendWebhook(charge(payment)).expect(200);
    const qr = (await Registration.findById(registrationId)).qrToken;

    const dup = await sendWebhook(charge(payment));
    expect(dup.status).toBe(200);
    expect(dup.body.data).toEqual({ duplicate: true });
    expect((await Registration.findById(registrationId)).qrToken).toBe(qr);
    await email.flush();
    expect(email.testOutbox.filter((m) => m.subject.startsWith('Your ticket'))).toHaveLength(1);
  });

  it('cancels and releases the seat when the charge fails', async () => {
    const { payment, registrationId, ticket } = await paidRegistration();
    const res = await sendWebhook({ event: 'charge.failed', data: { reference: payment.reference } });
    expect(res.body.data).toEqual({ failed: true });
    const reg = await Registration.findById(registrationId);
    expect(reg).toMatchObject({ status: 'cancelled', cancelReason: 'payment_failed' });
    expect((await Payment.findById(payment._id)).status).toBe('failed');
    expect((await TicketType.findById(ticket._id)).sold).toBe(0);
  });

  it('treats an amount mismatch as a failure and refunds it', async () => {
    const { payment, registrationId, refund } = await paidRegistration();
    const res = await sendWebhook(charge(payment, { amount: 100 }));
    expect(res.body.data).toMatchObject({ failed: true, amountMismatch: true });
    expect((await Registration.findById(registrationId)).status).toBe('cancelled');
    expect(refund).toHaveBeenCalledWith(payment.reference);
  });

  it('ignores unknown references and event types', async () => {
    await paidRegistration();
    expect((await sendWebhook({ event: 'charge.success', data: { reference: 'nope', amount: 1 } })).body.data).toEqual({ ignored: true });
    expect((await sendWebhook({ event: 'transfer.success', data: { reference: 'x' } })).body.data).toEqual({ ignored: true });
  });

  it('a late payment after the hold expired reclaims a free seat', async () => {
    const { payment, registrationId, ticket } = await paidRegistration();
    await Registration.updateOne({ _id: registrationId }, { holdExpiresAt: new Date(Date.now() - 1000) });
    expect(await expireHolds()).toBe(1);
    expect((await TicketType.findById(ticket._id)).sold).toBe(0);

    const res = await sendWebhook(charge(payment));
    expect(res.body.data).toEqual({ confirmed: true, reclaimed: true });
    expect((await Registration.findById(registrationId)).status).toBe('confirmed');
    expect((await TicketType.findById(ticket._id)).sold).toBe(1);
  });

  it('a late payment is refunded when the seat went to someone else', async () => {
    const { payment, registrationId, ticket, event, refund } = await paidRegistration({ quantity: 1 });
    const next = await createUser('attendee');
    await api().post(`/api/v1/events/${event._id}/register`).set(next.auth).send({ ticketTypeId: String(ticket._id) }).expect(202);

    await Registration.updateOne({ _id: registrationId }, { holdExpiresAt: new Date(Date.now() - 1000) });
    await expireHolds();
    // The waitlisted user was promoted into the freed seat.
    expect((await Registration.findOne({ user: next.user._id })).status).toBe('pending');

    const res = await sendWebhook(charge(payment));
    expect(res.body.data).toEqual({ refunded: true });
    expect(refund).toHaveBeenCalledWith(payment.reference);
    expect((await Payment.findById(payment._id)).status).toBe('refunded');
    expect((await Registration.findById(registrationId)).status).toBe('cancelled');
  });
});

describe('POST /payments/initialize', () => {
  it('returns the existing checkout link for my pending registration', async () => {
    const { att, registrationId, payment, init } = await paidRegistration();
    const res = await api().post('/api/v1/payments/initialize').set(att.auth).send({ registrationId });
    expect(res.status).toBe(200);
    expect(res.body.data.checkoutUrl).toBe(payment.checkoutUrl);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('starts a new checkout if there is no open payment', async () => {
    const { att, registrationId, payment, init } = await paidRegistration();
    await Payment.updateOne({ _id: payment._id }, { status: 'failed' });
    const res = await api().post('/api/v1/payments/initialize').set(att.auth).send({ registrationId });
    expect(res.status).toBe(200);
    expect(res.body.data.reference).not.toBe(payment.reference);
    expect(init).toHaveBeenCalledTimes(2);
  });

  it("refuses someone else's registration, confirmed ones and expired holds", async () => {
    const { att, registrationId } = await paidRegistration();
    const other = await createUser('attendee');
    expect((await api().post('/api/v1/payments/initialize').set(other.auth).send({ registrationId })).status).toBe(404);

    await Registration.updateOne({ _id: registrationId }, { holdExpiresAt: new Date(Date.now() - 1) });
    const expired = await api().post('/api/v1/payments/initialize').set(att.auth).send({ registrationId });
    expect(expired.body.error.code).toBe('HOLD_EXPIRED');

    await Registration.updateOne({ _id: registrationId }, { status: 'confirmed' });
    const confirmed = await api().post('/api/v1/payments/initialize').set(att.auth).send({ registrationId });
    expect(confirmed.body.error.code).toBe('NOT_PENDING');
  });
});
