import { api, createUser, setupEvent, paidTicket, mockPaystack } from '../helpers.js';
import Registration from '../../src/models/Registration.js';
import Payment from '../../src/models/Payment.js';
import TicketType from '../../src/models/TicketType.js';
import email from '../../src/services/email.service.js';

async function confirmedAttendee(event, ticket, name) {
  const att = await createUser('attendee', name ? { name } : {});
  const res = await api()
    .post(`/api/v1/events/${event._id}/register`)
    .set(att.auth)
    .send({ ticketTypeId: String(ticket._id) });
  return { att, qrToken: res.body.data.qrToken, registrationId: res.body.data.registrationId };
}

describe('check-in', () => {
  it('checks a ticket in once and blocks reuse with 409', async () => {
    const { organizer, event, ticket } = await setupEvent();
    const { qrToken, att } = await confirmedAttendee(event, ticket);
    const url = `/api/v1/events/${event._id}/check-in`;

    const first = await api().post(url).set(organizer.auth).send({ qrToken });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ status: 'checked-in', attendee: { email: att.user.email } });
    expect(first.body.data.checkedInAt).toBeDefined();

    const again = await api().post(url).set(organizer.auth).send({ qrToken });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('TICKET_ALREADY_USED');
  });

  it('handles simultaneous scans of the same code', async () => {
    const { organizer, event, ticket } = await setupEvent();
    const { qrToken } = await confirmedAttendee(event, ticket);
    const url = `/api/v1/events/${event._id}/check-in`;
    const results = await Promise.all([1, 2, 3].map(() => api().post(url).set(organizer.auth).send({ qrToken })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
  });

  it('rejects unknown codes, codes for other events and non-owners', async () => {
    const a = await setupEvent();
    const b = await setupEvent();
    const { qrToken } = await confirmedAttendee(a.event, a.ticket);

    const unknown = await api().post(`/api/v1/events/${a.event._id}/check-in`).set(a.organizer.auth).send({ qrToken: 'f'.repeat(64) });
    expect(unknown.status).toBe(404);
    const wrongEvent = await api().post(`/api/v1/events/${b.event._id}/check-in`).set(b.organizer.auth).send({ qrToken });
    expect(wrongEvent.status).toBe(404);
    const notOwner = await api().post(`/api/v1/events/${a.event._id}/check-in`).set(b.organizer.auth).send({ qrToken });
    expect(notOwner.status).toBe(403);
  });

  it('a cancelled ticket cannot be checked in', async () => {
    const { organizer, event, ticket } = await setupEvent();
    const { qrToken, att, registrationId } = await confirmedAttendee(event, ticket);
    await api().delete(`/api/v1/registrations/${registrationId}`).set(att.auth).expect(200);
    const res = await api().post(`/api/v1/events/${event._id}/check-in`).set(organizer.auth).send({ qrToken });
    expect(res.status).toBe(404);
  });
});

describe('reports', () => {
  it('stats: registrations by status, revenue and check-in rate', async () => {
    const { organizer, event, ticket } = await setupEvent({ ticket: { quantity: 2 } });
    const one = await confirmedAttendee(event, ticket);
    await confirmedAttendee(event, ticket);
    await confirmedAttendee(event, ticket); // waitlisted
    await api().post(`/api/v1/events/${event._id}/check-in`).set(organizer.auth).send({ qrToken: one.qrToken });
    await Payment.create({ registration: one.registrationId, event: event._id, reference: 'R1', amount: 1500, status: 'success' });
    await Payment.create({ registration: one.registrationId, event: event._id, reference: 'R2', amount: 999, status: 'failed' });

    const res = await api().get(`/api/v1/events/${event._id}/stats`).set(organizer.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.registrations).toMatchObject({ confirmed: 1, 'checked-in': 1, waitlisted: 1, total: 3 });
    expect(res.body.data.revenue).toEqual([{ currency: 'NGN', amount: 1500 }]);
    expect(res.body.data.checkInRate).toBe(0.5);
    expect(res.body.data.ticketTypes[0]).toMatchObject({ quantity: 2, sold: 2 });
  });

  it('attendee list is paginated and hides QR tokens', async () => {
    const { organizer, event, ticket } = await setupEvent();
    await confirmedAttendee(event, ticket);
    await confirmedAttendee(event, ticket);
    const res = await api().get(`/api/v1/events/${event._id}/attendees?limit=1`).set(organizer.auth);
    expect(res.body.meta).toEqual({ page: 1, limit: 1, total: 2 });
    expect(res.body.data[0].qrToken).toBeUndefined();
    expect(res.body.data[0].user.email).toBeDefined();
  });

  it('exports attendees as CSV with formula injection neutralised', async () => {
    const { organizer, event, ticket } = await setupEvent();
    await confirmedAttendee(event, ticket, '=HYPERLINK("http://evil")');
    const res = await api().get(`/api/v1/events/${event._id}/attendees.csv`).set(organizer.auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.trim().split('\n');
    expect(lines[0]).toBe('Name,Email,Ticket,Status,Registered At,Checked In At');
    expect(lines[1].startsWith(`"'=HYPERLINK(""http://evil"")"`)).toBe(true);
  });

  it('reports are owner-only', async () => {
    const { event } = await setupEvent();
    const other = await createUser('organizer');
    expect((await api().get(`/api/v1/events/${event._id}/stats`).set(other.auth)).status).toBe(403);
    const csv = await api().get(`/api/v1/events/${event._id}/attendees.csv`).set(other.auth);
    expect(csv.status).toBe(403);
    expect(csv.body.error.code).toBe('NOT_EVENT_OWNER');
  });
});

describe('event cancellation', () => {
  it('cancels every registration, refunds paid ones and notifies attendees', async () => {
    const { refund } = mockPaystack();
    const { organizer, event, ticket } = await setupEvent({ ticket: paidTicket() });
    const att = await createUser('attendee');
    const reg = await Registration.create({ event: event._id, user: att.user._id, ticketType: ticket._id, status: 'confirmed', qrToken: 'a'.repeat(64) });
    await Payment.create({ registration: reg._id, event: event._id, reference: 'PAID-1', amount: 500000, status: 'success' });
    await TicketType.updateOne({ _id: ticket._id }, { sold: 1 });

    const res = await api().delete(`/api/v1/events/${event._id}`).set(organizer.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.cancelled).toBe(true);
    expect((await Registration.findById(reg._id)).cancelReason).toBe('event_cancelled');
    expect(refund).toHaveBeenCalledWith('PAID-1');
    await email.flush();
    expect(email.testOutbox.some((m) => m.to === att.user.email && /cancelled/.test(m.subject))).toBe(true);
  });

  it('admins can change any event status', async () => {
    const { event } = await setupEvent();
    const admin = await createUser('admin');
    const res = await api().patch(`/api/v1/admin/events/${event._id}/status`).set(admin.auth).send({ status: 'draft' });
    expect(res.body.data.status).toBe('draft');
    const cancel = await api().patch(`/api/v1/admin/events/${event._id}/status`).set(admin.auth).send({ status: 'cancelled' });
    expect(cancel.body.data.status).toBe('cancelled');
    const reopen = await api().patch(`/api/v1/admin/events/${event._id}/status`).set(admin.auth).send({ status: 'published' });
    expect(reopen.status).toBe(409);
  });
});
