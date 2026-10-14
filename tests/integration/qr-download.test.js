import { api, createUser, setupEvent, paidTicket, mockPaystack } from '../helpers.js';
import { qrPng } from '../../src/services/qr.service.js';
import Registration from '../../src/models/Registration.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function confirmedTicket() {
  const { organizer, event, ticket } = await setupEvent();
  const att = await createUser('attendee');
  const res = await api()
    .post(`/api/v1/events/${event._id}/register`)
    .set(att.auth)
    .send({ ticketTypeId: String(ticket._id) })
    .expect(201);
  return { organizer, event, att, ...res.body.data };
}

describe('GET /registrations/:id/qr', () => {
  it('downloads the ticket QR as a PNG that encodes the registration token', async () => {
    const { att, event, registrationId, qrToken, qrUrl } = await confirmedTicket();
    expect(qrUrl).toBe(`/api/v1/registrations/${registrationId}/qr`);

    const res = await api().get(qrUrl).set(att.auth).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="ticket-${event.slug}-${registrationId}.png"`);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    // Same bytes as encoding the token directly, so the image scans to the right ticket.
    expect(res.body.equals(await qrPng(qrToken, 400))).toBe(true);
  });

  it('supports inline display and a custom size', async () => {
    const { att, qrUrl, qrToken } = await confirmedTicket();
    const res = await api().get(`${qrUrl}?inline=true&size=200`).set(att.auth).buffer(true).parse(binary);
    expect(res.headers['content-disposition']).toMatch(/^inline;/);
    expect(res.body.equals(await qrPng(qrToken, 200))).toBe(true);

    expect((await api().get(`${qrUrl}?size=5000`).set(att.auth)).status).toBe(400);
  });

  it('is available to the event organizer but hidden from other users', async () => {
    const { organizer, qrUrl } = await confirmedTicket();
    expect((await api().get(qrUrl).set(organizer.auth)).status).toBe(200);

    const stranger = await createUser('attendee');
    expect((await api().get(qrUrl).set(stranger.auth)).status).toBe(404);
    const otherOrg = await createUser('organizer');
    expect((await api().get(qrUrl).set(otherOrg.auth)).status).toBe(404);
    expect((await api().get(qrUrl)).status).toBe(401);
  });

  it('still works after check-in, but not for pending, waitlisted or cancelled registrations', async () => {
    const { organizer, event, att, registrationId, qrToken, qrUrl } = await confirmedTicket();
    await api().post(`/api/v1/events/${event._id}/check-in`).set(organizer.auth).send({ qrToken }).expect(200);
    expect((await api().get(qrUrl).set(att.auth)).status).toBe(200);

    await Registration.updateOne({ _id: registrationId }, { status: 'cancelled', $unset: { qrToken: 1 } });
    const cancelled = await api().get(qrUrl).set(att.auth);
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.error.code).toBe('NO_TICKET');

    mockPaystack();
    const paid = await setupEvent({ ticket: paidTicket() });
    const buyer = await createUser('attendee');
    const pending = await api()
      .post(`/api/v1/events/${paid.event._id}/register`)
      .set(buyer.auth)
      .send({ ticketTypeId: String(paid.ticket._id) });
    expect(pending.body.data.qrUrl).toBeUndefined();
    const res = await api().get(`/api/v1/registrations/${pending.body.data.registrationId}/qr`).set(buyer.auth);
    expect(res.status).toBe(409);
  });
});
