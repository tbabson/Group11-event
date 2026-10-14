import { jest } from '@jest/globals';
import { api, createUser, setupEvent, paidTicket } from '../helpers.js';
import env from '../../src/config/env.js';
import paystack from '../../src/services/paystack.client.js';
import Registration from '../../src/models/Registration.js';
import TicketType from '../../src/models/TicketType.js';
import email from '../../src/services/email.service.js';

async function paidRegistration() {
  const { event, ticket } = await setupEvent({ ticket: paidTicket() });
  const att = await createUser('attendee');
  const res = await api()
    .post(`/api/v1/events/${event._id}/register`)
    .set(att.auth)
    .send({ ticketTypeId: String(ticket._id) })
    .expect(201);
  const url = new URL(res.body.data.checkoutUrl);
  return { att, ticket, registrationId: res.body.data.registrationId, path: url.pathname, url };
}

describe('Paystack demo mode (default)', () => {
  it('returns a local demo checkout URL without calling Paystack', async () => {
    const post = jest.spyOn(paystack.http, 'post');
    const { url } = await paidRegistration();
    expect(url.origin).toBe(env.APP_URL);
    expect(url.pathname).toMatch(/^\/api\/v1\/payments\/demo\/checkout\/REG-/);
    expect(post).not.toHaveBeenCalled();
  });

  it('renders the checkout page with the amount', async () => {
    const { path } = await paidRegistration();
    const res = await api().get(path);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('PAYSTACK DEMO');
    expect(res.text).toMatch(/5,000\.00/);
    expect(res.text).toContain('Decline');
  });

  it('"Pay" confirms the registration through the signed webhook flow', async () => {
    const { path, registrationId, att } = await paidRegistration();
    const res = await api().post(`${path}/complete`).type('form').send({ outcome: 'success' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Payment successful');

    const reg = await Registration.findById(registrationId);
    expect(reg.status).toBe('confirmed');
    expect(reg.qrToken).toMatch(/^[a-f0-9]{64}$/);
    await email.flush();
    expect(email.testOutbox.some((m) => m.to === att.user.email && m.subject.startsWith('Your ticket'))).toBe(true);

    const again = await api().post(`${path}/complete`).type('form').send({ outcome: 'success' });
    expect(again.text).toContain('already processed');
    const page = await api().get(path);
    expect(page.text).toContain('Payment already success');
  });

  it('"Decline" cancels and frees the seat (JSON variant for Postman)', async () => {
    const { path, registrationId, ticket } = await paidRegistration();
    const res = await api().post(`${path}/complete`).send({ outcome: 'failed' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ outcome: 'failed', failed: true });
    expect((await Registration.findById(registrationId)).status).toBe('cancelled');
    expect((await TicketType.findById(ticket._id)).sold).toBe(0);
  });

  it('validates the outcome and the reference', async () => {
    const { path } = await paidRegistration();
    expect((await api().post(`${path}/complete`).send({ outcome: 'maybe' })).status).toBe(400);
    expect((await api().get('/api/v1/payments/demo/checkout/REG-nope')).status).toBe(404);
  });

  it('demo refunds succeed without a network call', async () => {
    const post = jest.spyOn(paystack.http, 'post');
    await expect(paystack.refundTransaction('REF-1')).resolves.toMatchObject({ demo: true });
    expect(post).not.toHaveBeenCalled();
  });
});

describe('Paystack live mode', () => {
  beforeEach(() => {
    env.PAYSTACK_MODE = 'live';
  });
  afterEach(() => {
    env.PAYSTACK_MODE = 'demo';
  });

  it('hides the demo checkout routes', async () => {
    expect((await api().get('/api/v1/payments/demo/checkout/REG-x')).status).toBe(404);
  });

  it('calls Paystack initialize and refund', async () => {
    const post = jest.spyOn(paystack.http, 'post').mockImplementation(async (url) =>
      url === '/transaction/initialize'
        ? { data: { status: true, data: { authorization_url: 'https://checkout.paystack.com/x', reference: 'R1' } } }
        : { data: { status: true, data: { status: 'pending' } } }
    );
    await expect(
      paystack.initializeTransaction({ email: 'a@b.dev', amount: 100, currency: 'NGN', reference: 'R1' })
    ).resolves.toEqual({ authorizationUrl: 'https://checkout.paystack.com/x', reference: 'R1' });
    await expect(paystack.refundTransaction('R1')).resolves.toEqual({ status: 'pending' });
    expect(post).toHaveBeenCalledWith('/refund', { transaction: 'R1' });
  });

  it('turns provider errors into 502 PAYMENT_PROVIDER_ERROR', async () => {
    jest.spyOn(paystack.http, 'post').mockRejectedValue({ response: { data: { message: 'Invalid key' } } });
    const err = await paystack.initializeTransaction({ email: 'a@b.dev', amount: 1, reference: 'R' }).catch((e) => e);
    expect(err).toMatchObject({ status: 502, code: 'PAYMENT_PROVIDER_ERROR' });
    expect(err.message).toContain('Invalid key');
  });
});
