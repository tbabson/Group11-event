import { jest } from '@jest/globals';
import crypto from 'crypto';
import { api, createUser, setupEvent, paidTicket, mockPaystack, sendWebhook, DAY, HOUR } from '../helpers.js';
import env from '../../src/config/env.js';
import paystack from '../../src/services/paystack.client.js';
import { splitPayment } from '../../src/services/fees.js';
import Event from '../../src/models/Event.js';
import Payment from '../../src/models/Payment.js';
import Payout from '../../src/models/Payout.js';
import Registration from '../../src/models/Registration.js';
import User from '../../src/models/User.js';
import { releaseDuePayouts } from '../../src/jobs/index.js';

const ACCOUNT = { bankCode: '058', accountNumber: '0123456789', accountName: 'Org Ventures' };

// A completed paid event with `count` successful payments of ₦5,000 each, ended `endedDaysAgo` days ago.
async function completedEvent({ count = 2, endedDaysAgo = 4, refunded = 0 } = {}) {
  const { organizer, event, ticket } = await setupEvent({ ticket: paidTicket() });
  for (let i = 0; i < count + refunded; i += 1) {
    const att = await createUser('attendee');
    const reg = await Registration.create({ event: event._id, user: att.user._id, ticketType: ticket._id, status: 'confirmed', qrToken: crypto.randomBytes(32).toString('hex') });
    await Payment.create({
      registration: reg._id,
      event: event._id,
      ticketType: ticket._id,
      reference: `P-${reg._id}`,
      amount: 500000,
      ...splitPayment(500000),
      status: i < count ? 'success' : 'refunded',
      processedAt: new Date(),
    });
  }
  const endAt = new Date(Date.now() - endedDaysAgo * DAY);
  await Event.updateOne({ _id: event._id }, { status: 'completed', startAt: new Date(endAt.getTime() - 3 * HOUR), endAt });
  return { organizer, event: await Event.findById(event._id), ticket };
}

describe('platform fee', () => {
  it('splits 5% to the platform by default', () => {
    expect(splitPayment(500000)).toEqual({ platformFee: 25000, organizerNet: 475000 });
    expect(splitPayment(0)).toEqual({ platformFee: 0, organizerNet: 0 });
  });

  it('supports a flat fee and never takes more than the price', () => {
    const before = { ...env };
    Object.assign(env, { PLATFORM_FEE_PERCENT: 5, PLATFORM_FEE_FLAT: 10000 });
    try {
      expect(splitPayment(500000)).toEqual({ platformFee: 35000, organizerNet: 465000 });
      expect(splitPayment(5000)).toEqual({ platformFee: 5000, organizerNet: 0 });
    } finally {
      Object.assign(env, { PLATFORM_FEE_PERCENT: before.PLATFORM_FEE_PERCENT, PLATFORM_FEE_FLAT: before.PLATFORM_FEE_FLAT });
    }
  });

  it('records the split on the payment at checkout', async () => {
    mockPaystack();
    const { event, ticket } = await setupEvent({ ticket: paidTicket() });
    const att = await createUser('attendee');
    const res = await api().post(`/api/v1/events/${event._id}/register`).set(att.auth).send({ ticketTypeId: String(ticket._id) });
    const payment = await Payment.findOne({ registration: res.body.data.registrationId });
    expect(payment).toMatchObject({ amount: 500000, platformFee: 25000, organizerNet: 475000 });
  });

  it('organizer stats show gross, fee, net and the held balance', async () => {
    const { organizer, event } = await completedEvent({ count: 2, refunded: 1, endedDaysAgo: 1 });
    const res = await api().get(`/api/v1/events/${event._id}/stats`).set(organizer.auth);
    expect(res.body.data.finance).toEqual([
      expect.objectContaining({
        currency: 'NGN',
        gross: 1000000,
        platformFee: 50000,
        organizerNet: 950000,
        refunded: 500000,
        held: 950000,
        payout: null,
      }),
    ]);
    const availableAt = new Date(res.body.data.finance[0].availableAt).getTime();
    expect(availableAt).toBe(event.endAt.getTime() + 3 * DAY);
  });
});

describe('payout account', () => {
  it('stores the account (masked in responses) for organizers only', async () => {
    const org = await createUser('organizer');
    const res = await api().put('/api/v1/me/payout-account').set(org.auth).send(ACCOUNT);
    expect(res.status).toBe(200);
    expect(res.body.data.payoutAccount).toMatchObject({ bankCode: '058', accountName: 'Org Ventures', accountNumber: '******6789' });
    expect(res.body.data.payoutAccount.recipientCode).toBeUndefined();
    expect((await User.findById(org.user._id)).payoutAccount.recipientCode).toMatch(/^RCP_demo_/);

    const att = await createUser('attendee');
    expect((await api().put('/api/v1/me/payout-account').set(att.auth).send(ACCOUNT)).status).toBe(403);
    const bad = await api().put('/api/v1/me/payout-account').set(org.auth).send({ ...ACCOUNT, accountNumber: '123' });
    expect(bad.status).toBe(400);
  });
});

describe('releasing payouts', () => {
  it('holds earnings until the hold period after the event has passed', async () => {
    const { organizer } = await completedEvent({ endedDaysAgo: 1 });
    await api().put('/api/v1/me/payout-account').set(organizer.auth).send(ACCOUNT);
    expect(await releaseDuePayouts()).toBe(0);
    expect(await Payout.countDocuments()).toBe(0);
  });

  it('pays the organizer net of fees and refunds, exactly once (demo transfer)', async () => {
    const { organizer, event } = await completedEvent({ count: 2, refunded: 1 });
    await api().put('/api/v1/me/payout-account').set(organizer.auth).send(ACCOUNT);

    expect(await releaseDuePayouts()).toBe(1);
    const payout = await Payout.findOne({ event: event._id });
    expect(payout).toMatchObject({ status: 'paid', grossAmount: 1000000, platformFee: 50000, amount: 950000, paymentCount: 2, demo: true });
    expect(await Payment.countDocuments({ payout: payout._id })).toBe(2);

    expect(await releaseDuePayouts()).toBe(0);
    expect(await Payout.countDocuments()).toBe(1);

    const mine = await api().get('/api/v1/me/payouts').set(organizer.auth);
    expect(mine.body.data[0]).toMatchObject({ amount: 950000, status: 'paid' });
    const stats = await api().get(`/api/v1/events/${event._id}/stats`).set(organizer.auth);
    expect(stats.body.data.finance[0]).toMatchObject({ held: 0, payout: { status: 'paid', amount: 950000 } });
  });

  it('waits for a payout account, then pays as soon as one is added', async () => {
    const { organizer, event } = await completedEvent();
    await releaseDuePayouts();
    expect((await Payout.findOne({ event: event._id })).status).toBe('awaiting_account');

    await api().put('/api/v1/me/payout-account').set(organizer.auth).send(ACCOUNT).expect(200);
    expect((await Payout.findOne({ event: event._id })).status).toBe('paid');
  });

  it('cancelled and free events produce no payout', async () => {
    const cancelled = await completedEvent();
    await Event.updateOne({ _id: cancelled.event._id }, { status: 'cancelled' });
    const free = await setupEvent();
    await Event.updateOne({ _id: free.event._id }, { status: 'completed', startAt: new Date(Date.now() - 5 * DAY), endAt: new Date(Date.now() - 4 * DAY) });
    await releaseDuePayouts();
    expect(await Payout.countDocuments()).toBe(0);
  });
});

describe('live transfers', () => {
  beforeEach(() => {
    env.PAYSTACK_MODE = 'live';
  });
  afterEach(() => {
    env.PAYSTACK_MODE = 'demo';
  });

  it('creates a recipient, starts a transfer and completes it on the transfer.success webhook', async () => {
    const post = jest.spyOn(paystack.http, 'post').mockImplementation(async (url) => {
      if (url === '/transferrecipient') return { data: { status: true, data: { recipient_code: 'RCP_live_1' } } };
      if (url === '/transfer') return { data: { status: true, data: { status: 'pending', transfer_code: 'TRF_1' } } };
      throw new Error(`unexpected ${url}`);
    });
    const { organizer, event } = await completedEvent();
    await api().put('/api/v1/me/payout-account').set(organizer.auth).send(ACCOUNT).expect(200);
    await releaseDuePayouts();

    const payout = await Payout.findOne({ event: event._id });
    expect(payout).toMatchObject({ status: 'processing', transferCode: 'TRF_1', demo: false });
    expect(post).toHaveBeenCalledWith('/transfer', expect.objectContaining({ amount: 950000, recipient: 'RCP_live_1', reference: payout.reference }));

    const res = await sendWebhook({ event: 'transfer.success', data: { reference: payout.reference } });
    expect(res.body.data).toEqual({ payout: 'paid' });
    expect((await Payout.findById(payout._id)).paidAt).toBeDefined();
  });

  it('marks failed transfers and lets an admin retry with a new reference', async () => {
    const { organizer, event } = await completedEvent();
    jest.spyOn(paystack.http, 'post').mockImplementation(async (url) => {
      if (url === '/transferrecipient') return { data: { status: true, data: { recipient_code: 'RCP_live_2' } } };
      throw Object.assign(new Error('fail'), { response: { data: { message: 'Insufficient balance' } } });
    });
    await api().put('/api/v1/me/payout-account').set(organizer.auth).send(ACCOUNT);
    await releaseDuePayouts();
    const failed = await Payout.findOne({ event: event._id });
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toContain('Insufficient balance');

    paystack.http.post.mockImplementation(async () => ({ data: { status: true, data: { status: 'success', transfer_code: 'TRF_2' } } }));
    const admin = await createUser('admin');
    const retry = await api().post(`/api/v1/admin/payouts/${failed._id}/retry`).set(admin.auth);
    expect(retry.status).toBe(200);
    expect(retry.body.data).toMatchObject({ status: 'paid', attempts: 2 });
    expect(retry.body.data.reference).not.toBe(failed.reference);

    const again = await api().post(`/api/v1/admin/payouts/${failed._id}/retry`).set(admin.auth);
    expect(again.body.error.code).toBe('PAYOUT_NOT_RETRYABLE');
  });

  it('transfer.failed / reversed webhooks mark the payout failed', async () => {
    const org = await createUser('organizer');
    const ev = await setupEvent();
    const p = await Payout.create({ organizer: org.user._id, event: ev.event._id, amount: 100, status: 'processing', reference: 'payout_test_ref_1' });
    const res = await sendWebhook({ event: 'transfer.reversed', data: { reference: 'payout_test_ref_1' } });
    expect(res.body.data).toEqual({ payout: 'failed' });
    expect((await Payout.findById(p._id)).failureReason).toBe('Transfer reversed');
  });
});

describe('admin finance', () => {
  it('reports platform revenue and lists payouts', async () => {
    const { organizer } = await completedEvent({ count: 3, refunded: 1 });
    await api().put('/api/v1/me/payout-account').set(organizer.auth).send(ACCOUNT);
    await releaseDuePayouts();
    const admin = await createUser('admin');

    const revenue = await api().get('/api/v1/admin/revenue').set(admin.auth);
    expect(revenue.status).toBe(200);
    expect(revenue.body.data).toMatchObject({
      feePercent: 5,
      revenue: [{ currency: 'NGN', gross: 1500000, platformFees: 75000, organizerNet: 1425000, payments: 3 }],
      payouts: [{ currency: 'NGN', status: 'paid', amount: 1425000 }],
    });

    const list = await api().get('/api/v1/admin/payouts?status=paid').set(admin.auth);
    expect(list.body.meta.total).toBe(1);
    expect((await api().get('/api/v1/admin/revenue').set(organizer.auth)).status).toBe(403);
  });
});
