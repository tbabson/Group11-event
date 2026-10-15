import { jest } from '@jest/globals';
import { api, createUser, setupEvent, paidTicket, sendWebhook, DAY, HOUR } from '../helpers.js';
import env from '../../src/config/env.js';
import paystack from '../../src/services/paystack.client.js';
import Event from '../../src/models/Event.js';
import Payment from '../../src/models/Payment.js';
import Transaction from '../../src/models/Transaction.js';
import { releaseDuePayouts } from '../../src/jobs/index.js';

// Buys a paid ticket through the RepairHub-style /transactions/pay route (demo mode).
async function buy({ event: eventOverrides } = {}) {
  const { organizer, event, ticket } = await setupEvent({ ticket: paidTicket(), event: eventOverrides });
  const att = await createUser('attendee');
  const reg = await api().post(`/api/v1/events/${event._id}/register`).set(att.auth).send({ ticketTypeId: String(ticket._id) });
  const pay = await api().post('/api/v1/transactions/pay').set(att.auth).send({ registrationId: reg.body.data.registrationId });
  return { organizer, event, ticket, att, registrationId: reg.body.data.registrationId, pay };
}

const completeDemo = (reference, outcome) =>
  api().post(`/api/v1/payments/demo/checkout/${encodeURIComponent(reference)}/complete`).send({ outcome });

describe('transaction ledger', () => {
  it('POST /transactions/pay returns the checkout and records a pending ticket payment', async () => {
    const { pay, att } = await buy();
    expect(pay.status).toBe(201);
    expect(pay.body.data).toMatchObject({ checkoutUrl: expect.stringContaining('/payments/demo/checkout/') });
    const rows = await Transaction.find({ reference: pay.body.data.reference });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'ticket_payment', status: 'pending', amount: 500000 });
    expect(String(rows[0].user)).toBe(String(att.user._id));
  });

  it('a successful payment marks it success and books the platform commission to the organizer', async () => {
    const { pay, att, organizer } = await buy();
    await completeDemo(pay.body.data.reference, 'success').expect(200);

    const mine = await api().get('/api/v1/transactions/me').set(att.auth);
    expect(mine.body.data.map((t) => [t.type, t.status, t.amount])).toEqual([['ticket_payment', 'success', 500000]]);
    expect(mine.body.data[0].event.title).toBeDefined();

    const orgRows = await api().get('/api/v1/transactions/me').set(organizer.auth);
    expect(orgRows.body.data.map((t) => [t.type, t.status, t.amount])).toEqual([['commission', 'success', 25000]]);
  });

  it('is idempotent: a duplicate webhook on /transactions/webhook/paystack adds nothing', async () => {
    const { pay } = await buy();
    const payment = await Payment.findOne({ reference: pay.body.data.reference });
    await completeDemo(payment.reference, 'success');
    const before = await Transaction.countDocuments();

    // Duplicate on the original path...
    const dup = await sendWebhook({ event: 'charge.success', data: { reference: payment.reference, amount: payment.amount, currency: 'NGN' } });
    expect(dup.body.data).toEqual({ duplicate: true });

    // ...and on the RepairHub-style path.
    const raw = JSON.stringify({ event: 'charge.success', data: { reference: payment.reference, amount: payment.amount, currency: 'NGN' } });
    const res = await api()
      .post('/api/v1/transactions/webhook/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', paystack.sign(raw))
      .send(raw);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ duplicate: true });
    expect(await Transaction.countDocuments()).toBe(before);

    const bad = await api().post('/api/v1/transactions/webhook/paystack').set('x-paystack-signature', 'nope').send(raw);
    expect(bad.status).toBe(401);
  });

  it('a declined payment is recorded as failed, with no commission', async () => {
    const { pay } = await buy();
    await completeDemo(pay.body.data.reference, 'failed').expect(200);
    const rows = await Transaction.find({}).lean();
    expect(rows.map((t) => [t.type, t.status])).toEqual([['ticket_payment', 'failed']]);
  });

  it('a refund is recorded and the commission reversed', async () => {
    const { pay, att, registrationId } = await buy({ event: { refundPolicy: 'full' } });
    await completeDemo(pay.body.data.reference, 'success');
    await api().delete(`/api/v1/registrations/${registrationId}`).set(att.auth).expect(200);

    const rows = await Transaction.find({}).sort({ createdAt: 1 }).lean();
    expect(rows.map((t) => [t.type, t.status, t.amount])).toEqual([
      ['ticket_payment', 'success', 500000],
      ['commission', 'reversed', 25000],
      ['refund', 'success', 500000],
    ]);
    expect(String(rows[2].user)).toBe(String(att.user._id));
  });

  it("an organizer payout is recorded on the organizer's ledger", async () => {
    const { pay, organizer, event } = await buy();
    await completeDemo(pay.body.data.reference, 'success');
    await Event.updateOne(
      { _id: event._id },
      { status: 'completed', startAt: new Date(Date.now() - 5 * DAY), endAt: new Date(Date.now() - 4 * DAY - HOUR) }
    );
    await api()
      .put('/api/v1/me/payout-account')
      .set(organizer.auth)
      .send({ bankCode: '058', accountNumber: '0123456789', accountName: 'Org' })
      .expect(200);
    await releaseDuePayouts();

    const res = await api().get('/api/v1/transactions/me?type=payout').set(organizer.auth);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ type: 'payout', status: 'success', amount: 475000 });
    expect(res.body.meta.total).toBe(1);
  });
});

describe('GET /transactions/verify/:reference (live mode)', () => {
  afterEach(() => {
    env.PAYSTACK_MODE = 'demo';
  });

  it('confirms with Paystack and updates the ledger', async () => {
    env.PAYSTACK_MODE = 'live';
    jest
      .spyOn(paystack, 'initializeTransaction')
      .mockImplementation(async ({ reference }) => ({ authorizationUrl: `https://checkout.paystack.com/${reference}`, reference }));
    const { pay, att } = await buy();
    const reference = pay.body.data.reference;
    jest.spyOn(paystack.http, 'get').mockResolvedValue({ data: { status: true, data: { status: 'success', amount: 500000, currency: 'NGN' } } });

    const res = await api().get(`/api/v1/transactions/verify/${encodeURIComponent(reference)}`).set(att.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ paymentStatus: 'success', registrationStatus: 'confirmed' });
    expect((await Transaction.findOne({ reference })).status).toBe('success');

    const other = await createUser('attendee');
    expect((await api().get(`/api/v1/transactions/verify/${encodeURIComponent(reference)}`).set(other.auth)).status).toBe(404);
  });
});

describe('GET /admin/transactions', () => {
  it('lists the whole ledger with filters, admins only', async () => {
    const { pay, event } = await buy();
    await completeDemo(pay.body.data.reference, 'success');
    const admin = await createUser('admin');

    const all = await api().get('/api/v1/admin/transactions').set(admin.auth);
    expect(all.body.meta.total).toBe(2);
    const fees = await api().get(`/api/v1/admin/transactions?type=commission&event=${event._id}`).set(admin.auth);
    expect(fees.body.data).toHaveLength(1);
    expect(fees.body.data[0].user.role).toBe('organizer');

    const att = await createUser('attendee');
    expect((await api().get('/api/v1/admin/transactions').set(att.auth)).status).toBe(403);
    expect((await api().get('/api/v1/admin/transactions?type=bogus').set(admin.auth)).status).toBe(400);
  });
});
