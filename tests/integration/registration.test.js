import { jest } from '@jest/globals';
import { api, createUser, setupEvent, paidTicket, mockPaystack, DAY } from '../helpers.js';
import email from '../../src/services/email.service.js';
import Registration from '../../src/models/Registration.js';
import TicketType from '../../src/models/TicketType.js';
import Payment from '../../src/models/Payment.js';
import AppError from '../../src/utils/AppError.js';
import paystack from '../../src/services/paystack.client.js';

const register = (who, event, ticket) =>
  api().post(`/api/v1/events/${event._id}/register`).set(who.auth).send({ ticketTypeId: String(ticket._id) });

describe('registration', () => {
  it('confirms a free ticket with a QR token and emails it', async () => {
    const { event, ticket } = await setupEvent();
    const att = await createUser('attendee');
    const res = await register(att, event, ticket);
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('confirmed');
    expect(res.body.data.qrToken).toMatch(/^[a-f0-9]{64}$/);
    expect((await TicketType.findById(ticket._id)).sold).toBe(1);

    await email.flush();
    const mail = email.testOutbox.find((m) => m.subject.startsWith('Your ticket'));
    expect(mail.to).toBe(att.user.email);
    expect(mail.attachments[0].cid).toBe('ticket-qr-1');
  });

  it('holds a paid seat for 15 minutes and returns the checkout URL', async () => {
    const { init } = mockPaystack();
    const { event, ticket } = await setupEvent({ ticket: paidTicket() });
    const att = await createUser('attendee');
    const res = await register(att, event, ticket);
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('pending');
    expect(res.body.data.checkoutUrl).toMatch(/^https:\/\/checkout\.paystack\.com\/REG-/);
    const hold = new Date(res.body.data.holdExpiresAt).getTime() - Date.now();
    expect(hold).toBeGreaterThan(14 * 60 * 1000);
    expect(hold).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ amount: 500000, email: att.user.email }));
    expect(await Payment.countDocuments({ status: 'initialized' })).toBe(1);
  });

  it('releases the held seat if Paystack is down', async () => {
    jest
      .spyOn(paystack, 'initializeTransaction')
      .mockRejectedValue(new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'Payment provider error: down'));
    const { event, ticket } = await setupEvent({ ticket: paidTicket() });
    const att = await createUser('attendee');
    const res = await register(att, event, ticket);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PAYMENT_PROVIDER_ERROR');
    expect((await TicketType.findById(ticket._id)).sold).toBe(0);
    expect((await Registration.findOne({ user: att.user._id })).status).toBe('cancelled');
  });

  it('lets the same person buy again for the same event (a separate ticket)', async () => {
    const { event, ticket } = await setupEvent();
    const att = await createUser('attendee');
    const first = await register(att, event, ticket).expect(201);
    const again = await register(att, event, ticket);
    expect(again.status).toBe(201);
    expect(again.body.data.registrationId).not.toBe(first.body.data.registrationId);
    expect(again.body.data.qrToken).not.toBe(first.body.data.qrToken);
    expect((await TicketType.findById(ticket._id)).sold).toBe(2);
  });

  it('refuses unpublished events, closed sales and organizers', async () => {
    const att = await createUser('attendee');
    const draft = await setupEvent({ event: { status: 'draft' } });
    expect((await register(att, draft.event, draft.ticket)).body.error.code).toBe('EVENT_NOT_OPEN');

    const closed = await setupEvent({ ticket: { saleEnd: new Date(Date.now() - 1000), saleStart: new Date(Date.now() - DAY) } });
    expect((await register(att, closed.event, closed.ticket)).body.error.code).toBe('SALE_CLOSED');

    const org = await createUser('organizer');
    expect((await register(org, closed.event, closed.ticket)).status).toBe(403);
  });

  it('404s for a ticket type from another event', async () => {
    const a = await setupEvent();
    const b = await setupEvent();
    const att = await createUser('attendee');
    const res = await register(att, a.event, b.ticket);
    expect(res.status).toBe(404);
  });

  it('waitlists with 202 once sold out', async () => {
    const { event, ticket } = await setupEvent({ ticket: { quantity: 1 } });
    const a = await createUser('attendee');
    const b = await createUser('attendee');
    await register(a, event, ticket).expect(201);
    const res = await register(b, event, ticket);
    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('waitlisted');
  });

  it('never oversells the last seat under concurrent requests', async () => {
    const { event, ticket } = await setupEvent({ ticket: { quantity: 1 } });
    const users = await Promise.all(Array.from({ length: 10 }, () => createUser('attendee')));
    const results = await Promise.all(users.map((u) => register(u, event, ticket)));

    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 202)).toHaveLength(9);
    expect((await TicketType.findById(ticket._id)).sold).toBe(1);
    expect(await Registration.countDocuments({ status: 'confirmed' })).toBe(1);
    expect(await Registration.countDocuments({ status: 'waitlisted' })).toBe(9);
  });

  it('a cancellation frees the seat and promotes the oldest waitlisted user', async () => {
    const { event, ticket } = await setupEvent({ ticket: { quantity: 1 } });
    const [a, b, c] = await Promise.all([createUser(), createUser(), createUser()]);
    const first = await register(a, event, ticket);
    await register(b, event, ticket).expect(202);
    await register(c, event, ticket).expect(202);

    const res = await api().delete(`/api/v1/registrations/${first.body.data.registrationId}`).set(a.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');

    const regB = await Registration.findOne({ user: b.user._id });
    const regC = await Registration.findOne({ user: c.user._id });
    expect(regB.status).toBe('confirmed');
    expect(regB.qrToken).toBeDefined();
    expect(regC.status).toBe('waitlisted');
    expect((await TicketType.findById(ticket._id)).sold).toBe(1);
  });

  it('promotes a waitlisted user to pending with a checkout link for paid tickets', async () => {
    mockPaystack();
    const { event, ticket } = await setupEvent({ ticket: paidTicket({ quantity: 1 }) });
    const [a, b] = await Promise.all([createUser(), createUser()]);
    const first = await register(a, event, ticket);
    await register(b, event, ticket).expect(202);

    await api().delete(`/api/v1/registrations/${first.body.data.registrationId}`).set(a.auth).expect(200);
    const regB = await Registration.findOne({ user: b.user._id });
    expect(regB.status).toBe('pending');
    expect(regB.holdExpiresAt.getTime()).toBeGreaterThan(Date.now());
    await email.flush();
    expect(email.testOutbox.some((m) => m.to === b.user.email && /seat opened up/.test(m.subject))).toBe(true);
  });

  it('lets a user register again after cancelling', async () => {
    const { event, ticket } = await setupEvent();
    const att = await createUser('attendee');
    const first = await register(att, event, ticket);
    await api().delete(`/api/v1/registrations/${first.body.data.registrationId}`).set(att.auth).expect(200);
    const again = await register(att, event, ticket);
    expect(again.status).toBe(201);
    expect(again.body.data.registrationId).not.toBe(first.body.data.registrationId); // a new ticket
    expect((await TicketType.findById(ticket._id)).sold).toBe(1);
  });

  it('only the attendee or the organizer can cancel, and only before the event', async () => {
    const { organizer, event, ticket } = await setupEvent();
    const att = await createUser('attendee');
    const stranger = await createUser('attendee');
    const { body } = await register(att, event, ticket);
    const url = `/api/v1/registrations/${body.data.registrationId}`;

    expect((await api().delete(url).set(stranger.auth)).status).toBe(404);
    expect((await api().delete(url).set(organizer.auth)).status).toBe(200);
    expect((await api().delete(url).set(att.auth)).body.error.code).toBe('CANNOT_CANCEL');
  });

  it('refunds paid tickets on cancellation when the event refund policy is full', async () => {
    const { refund } = mockPaystack();
    const { event, ticket } = await setupEvent({ ticket: paidTicket(), event: { refundPolicy: 'full' } });
    const att = await createUser('attendee');
    const reg = await Registration.create({ event: event._id, user: att.user._id, ticketType: ticket._id, status: 'confirmed', qrToken: 'q'.repeat(64) });
    await Payment.create({ registration: reg._id, event: event._id, reference: 'REF-1', amount: 500000, status: 'success' });
    await TicketType.updateOne({ _id: ticket._id }, { sold: 1 });

    await api().delete(`/api/v1/registrations/${reg._id}`).set(att.auth).expect(200);
    expect(refund).toHaveBeenCalledWith('REF-1');
    expect((await Payment.findOne({ reference: 'REF-1' })).status).toBe('refunded');
  });

  it('lists my registrations with pagination', async () => {
    const { event, ticket } = await setupEvent();
    const att = await createUser('attendee');
    await register(att, event, ticket);
    const res = await api().get('/api/v1/me/registrations').set(att.auth);
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(1);
    expect(res.body.data[0].event.title).toBe(event.title);
  });
});
