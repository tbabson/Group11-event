import { jest } from '@jest/globals';
import { api, createUser, setupEvent, paidTicket } from '../helpers.js';
import env from '../../src/config/env.js';
import paystack from '../../src/services/paystack.client.js';
import Payment from '../../src/models/Payment.js';
import Registration from '../../src/models/Registration.js';
import TicketType from '../../src/models/TicketType.js';

// Registers for a paid ticket in live mode (Paystack initialize stubbed) and returns the pieces.
async function livePaidRegistration() {
  const { event, ticket } = await setupEvent({ ticket: paidTicket() });
  const att = await createUser('attendee');
  const res = await api()
    .post(`/api/v1/events/${event._id}/register`)
    .set(att.auth)
    .send({ ticketTypeId: String(ticket._id) })
    .expect(201);
  const payment = await Payment.findOne({ registration: res.body.data.registrationId });
  return { att, event, ticket, registrationId: res.body.data.registrationId, payment };
}

const verify = (who, reference) => api().post('/api/v1/payments/verify').set(who.auth).send({ reference });

describe('Paystack live mode: callback URL and POST /payments/verify', () => {
  let init;
  beforeEach(() => {
    env.PAYSTACK_MODE = 'live';
    init = jest
      .spyOn(paystack, 'initializeTransaction')
      .mockImplementation(async ({ reference }) => ({ authorizationUrl: `https://checkout.paystack.com/${reference}`, reference }));
  });
  afterEach(() => {
    env.PAYSTACK_MODE = 'demo';
  });

  it('sends PAYSTACK_CALLBACK_URL to Paystack as the redirect after payment', async () => {
    await livePaidRegistration();
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ callbackUrl: env.PAYSTACK_CALLBACK_URL }));
  });

  it('confirms the ticket when Paystack says the payment succeeded, even with no webhook', async () => {
    const { att, registrationId, payment, event } = await livePaidRegistration();
    const get = jest
      .spyOn(paystack.http, 'get')
      .mockResolvedValue({ data: { status: true, data: { status: 'success', amount: payment.amount, currency: 'NGN' } } });

    const res = await verify(att, payment.reference);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ paymentStatus: 'success', registrationStatus: 'confirmed', event: { slug: event.slug } });
    expect(get).toHaveBeenCalledWith(`/transaction/verify/${encodeURIComponent(payment.reference)}`);
    expect((await Registration.findById(registrationId)).qrToken).toMatch(/^[a-f0-9]{64}$/);

    // Repeating is harmless and doesn't ask Paystack again.
    const again = await verify(att, payment.reference);
    expect(again.body.data.registrationStatus).toBe('confirmed');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('cancels and frees the seat when the payment failed', async () => {
    const { att, ticket, payment } = await livePaidRegistration();
    jest.spyOn(paystack.http, 'get').mockResolvedValue({ data: { status: true, data: { status: 'failed' } } });
    const res = await verify(att, payment.reference);
    expect(res.body.data).toMatchObject({ paymentStatus: 'failed', registrationStatus: 'cancelled' });
    expect((await TicketType.findById(ticket._id)).sold).toBe(0);
  });

  it('leaves an unfinished (abandoned) payment pending', async () => {
    const { att, payment } = await livePaidRegistration();
    jest.spyOn(paystack.http, 'get').mockResolvedValue({ data: { status: true, data: { status: 'abandoned' } } });
    const res = await verify(att, payment.reference);
    expect(res.body.data).toMatchObject({ paymentStatus: 'initialized', registrationStatus: 'pending' });
  });

  it("refuses someone else's payment and unknown references", async () => {
    const { payment } = await livePaidRegistration();
    const stranger = await createUser('attendee');
    expect((await verify(stranger, payment.reference)).status).toBe(404);
    expect((await verify(stranger, 'REG-nope-123')).status).toBe(404);
    expect((await api().post('/api/v1/payments/verify').send({ reference: payment.reference })).status).toBe(401);
  });

  it('reports a Paystack outage as 502 without changing anything', async () => {
    const { att, payment } = await livePaidRegistration();
    jest.spyOn(paystack.http, 'get').mockRejectedValue({ response: { data: { message: 'Service unavailable' } } });
    const res = await verify(att, payment.reference);
    expect(res.status).toBe(502);
    expect((await Payment.findById(payment._id)).status).toBe('initialized');
  });
});

describe('resuming checkout with a saved link', () => {
  async function pendingDemoRegistration() {
    const { event, ticket } = await setupEvent({ ticket: paidTicket() });
    const att = await createUser('attendee');
    const res = await api().post(`/api/v1/events/${event._id}/register`).set(att.auth).send({ ticketTypeId: String(ticket._id) });
    const payment = await Payment.findOne({ registration: res.body.data.registrationId });
    return { att, registrationId: res.body.data.registrationId, payment };
  }

  it('rebuilds a demo link that was saved with an old/wrong APP_URL', async () => {
    const { att, registrationId, payment } = await pendingDemoRegistration();
    await Payment.updateOne(
      { _id: payment._id },
      { checkoutUrl: `http://localhost:4001/api/v1/payments/demo/checkout/${payment.reference}` }
    );
    const res = await api().post('/api/v1/payments/initialize').set(att.auth).send({ registrationId });
    expect(res.body.data.checkoutUrl).toBe(`${env.APP_URL}/api/v1/payments/demo/checkout/${encodeURIComponent(payment.reference)}`);
    expect(res.body.data.reference).toBe(payment.reference);
  });

  it('starts a real Paystack checkout when the saved link is a demo one and the mode is now live', async () => {
    const { att, registrationId, payment } = await pendingDemoRegistration();
    env.PAYSTACK_MODE = 'live';
    try {
      jest
        .spyOn(paystack, 'initializeTransaction')
        .mockImplementation(async ({ reference }) => ({ authorizationUrl: `https://checkout.paystack.com/${reference}`, reference }));
      const res = await api().post('/api/v1/payments/initialize').set(att.auth).send({ registrationId });
      expect(res.body.data.checkoutUrl).toMatch(/^https:\/\/checkout\.paystack\.com\//);
      expect(res.body.data.reference).not.toBe(payment.reference);
      expect((await Payment.findById(payment._id)).status).toBe('failed');
    } finally {
      env.PAYSTACK_MODE = 'demo';
    }
  });
});

describe('demo checkout redirect', () => {
  it('sends the buyer back to PAYSTACK_CALLBACK_URL with trxref and reference, like Paystack', async () => {
    const { event, ticket } = await setupEvent({ ticket: paidTicket() });
    const att = await createUser('attendee');
    const reg = await api().post(`/api/v1/events/${event._id}/register`).set(att.auth).send({ ticketTypeId: String(ticket._id) });
    const path = new URL(reg.body.data.checkoutUrl).pathname;
    const reference = decodeURIComponent(path.split('/').pop());

    const res = await api().post(`${path}/complete`).type('form').send({ outcome: 'success' });
    const expected = new URL(env.PAYSTACK_CALLBACK_URL);
    expected.searchParams.set('trxref', reference);
    expected.searchParams.set('reference', reference);
    expect(res.text).toContain(`<meta http-equiv="refresh" content="3;url=${expected.href.replace(/&/g, '&amp;')}">`);

    // In demo mode verify just reports the state the demo checkout already applied.
    const get = jest.spyOn(paystack.http, 'get');
    const v = await verify(att, reference);
    expect(v.body.data).toMatchObject({ paymentStatus: 'success', registrationStatus: 'confirmed' });
    expect(get).not.toHaveBeenCalled();
  });
});
