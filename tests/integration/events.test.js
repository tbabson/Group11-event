import { jest } from '@jest/globals';
import { api, createUser, createEvent, createTicket, setupEvent, DAY, HOUR } from '../helpers.js';
import Event from '../../src/models/Event.js';
import TicketType from '../../src/models/TicketType.js';
import Registration from '../../src/models/Registration.js';
import cloudinaryPkg from 'cloudinary';
import env from '../../src/config/env.js';
import upload from '../../src/services/upload.service.js';

const future = (days) => new Date(Date.now() + days * DAY).toISOString();
const eventBody = (overrides = {}) => ({
  title: 'Lagos JS Meetup',
  description: 'Talks about JavaScript',
  category: 'Tech',
  venue: { name: 'Zone Tech Park', city: 'Lagos' },
  startAt: future(10),
  endAt: new Date(Date.now() + 10 * DAY + 3 * HOUR).toISOString(),
  capacity: 50,
  ...overrides,
});

describe('event management', () => {
  it('lets an organizer create a draft event with a slug', async () => {
    const org = await createUser('organizer');
    const res = await api().post('/api/v1/events').set(org.auth).send(eventBody());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'draft', slug: 'lagos-js-meetup', category: 'tech' });

    const second = await api().post('/api/v1/events').set(org.auth).send(eventBody());
    expect(second.body.data.slug).toMatch(/^lagos-js-meetup-[a-f0-9]{6}$/);
  });

  it('blocks attendees from creating events', async () => {
    const att = await createUser('attendee');
    const res = await api().post('/api/v1/events').set(att.auth).send(eventBody());
    expect(res.status).toBe(403);
  });

  it('validates dates, location and unknown fields', async () => {
    const org = await createUser('organizer');
    const badDates = await api().post('/api/v1/events').set(org.auth).send(eventBody({ endAt: future(5) }));
    expect(badDates.status).toBe(400);
    expect(badDates.body.error.details[0].field).toBe('endAt');

    const noPlace = await api().post('/api/v1/events').set(org.auth).send(eventBody({ venue: undefined }));
    expect(noPlace.status).toBe(400);

    const sneaky = await api().post('/api/v1/events').set(org.auth).send(eventBody({ status: 'published' }));
    expect(sneaky.status).toBe(400);
  });

  it('only the owner (or an admin) can edit', async () => {
    const { event } = await setupEvent();
    const other = await createUser('organizer');
    const res = await api().patch(`/api/v1/events/${event._id}`).set(other.auth).send({ title: 'Hijacked' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_EVENT_OWNER');

    const admin = await createUser('admin');
    const ok = await api().patch(`/api/v1/events/${event._id}`).set(admin.auth).send({ title: 'Renamed' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.title).toBe('Renamed');
  });

  it('returns 400 for malformed ids and 404 for missing events', async () => {
    const org = await createUser('organizer');
    expect((await api().patch('/api/v1/events/not-an-id').set(org.auth).send({ title: 'x y z' })).status).toBe(400);
    const missing = await api().patch('/api/v1/events/507f1f77bcf86cd799439011').set(org.auth).send({ title: 'abc' });
    expect(missing.status).toBe(404);
  });

  it('will not shrink capacity below allocated tickets', async () => {
    const { organizer, event } = await setupEvent({ ticket: { quantity: 40 } });
    const res = await api().patch(`/api/v1/events/${event._id}`).set(organizer.auth).send({ capacity: 30 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAPACITY_TOO_LOW');
  });

  it('publishing needs a ticket type; unpublishing is blocked once people registered', async () => {
    const org = await createUser('organizer');
    const ev = await createEvent(org.user, { status: 'draft' });
    const noTickets = await api().post(`/api/v1/events/${ev._id}/publish`).set(org.auth);
    expect(noTickets.status).toBe(409);
    expect(noTickets.body.error.code).toBe('NO_TICKETS');

    const tt = await createTicket(ev);
    expect((await api().post(`/api/v1/events/${ev._id}/publish`).set(org.auth)).body.data.status).toBe('published');

    const att = await createUser('attendee');
    await Registration.create({ event: ev._id, user: att.user._id, ticketType: tt._id, status: 'confirmed' });
    const unpub = await api().post(`/api/v1/events/${ev._id}/unpublish`).set(org.auth);
    expect(unpub.status).toBe(409);
  });

  it('DELETE removes an event nobody registered for', async () => {
    const { organizer, event } = await setupEvent();
    const res = await api().delete(`/api/v1/events/${event._id}`).set(organizer.auth);
    expect(res.body.data).toEqual({ deleted: true });
    expect(await Event.exists({ _id: event._id })).toBeNull();
    expect(await TicketType.countDocuments({ event: event._id })).toBe(0);
  });

  it('uploads a banner to the configured Cloudinary folder using the separate keys', async () => {
    const cloudinary = cloudinaryPkg.v2;
    Object.assign(env, { CLOUDINARY_CLOUD_NAME: 'demo-cloud', CLOUDINARY_API_KEY: 'key', CLOUDINARY_API_SECRET: 'secret', CLOUDINARY_FOLDER: 'group11' });
    upload._reset();
    const config = jest.spyOn(cloudinary, 'config');
    const stream = jest.spyOn(cloudinary.uploader, 'upload_stream').mockImplementation((opts, cb) => ({
      end: () => cb(null, { secure_url: `https://res.cloudinary.com/demo-cloud/${opts.folder}/${opts.public_id}.png` }),
    }));
    try {
      const { organizer, event } = await setupEvent();
      const res = await api()
        .post(`/api/v1/events/${event._id}/banner`)
        .set(organizer.auth)
        .attach('banner', Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: 'b.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
      expect(res.body.data.bannerUrl).toBe(`https://res.cloudinary.com/demo-cloud/group11/${event._id}.png`);
      expect(config).toHaveBeenCalledWith(expect.objectContaining({ cloud_name: 'demo-cloud', api_key: 'key', api_secret: 'secret' }));
      expect(stream.mock.calls[0][0]).toMatchObject({
        folder: 'group11',
        public_id: String(event._id),
        transformation: [{ width: 1080, height: 608, crop: 'fill', gravity: 'auto', quality: 'auto' }],
      });
    } finally {
      Object.assign(env, { CLOUDINARY_CLOUD_NAME: undefined, CLOUDINARY_API_KEY: undefined, CLOUDINARY_API_SECRET: undefined, CLOUDINARY_FOLDER: 'event-banners' });
      upload._reset();
    }
  });

  it('banner upload returns 503 when Cloudinary is not configured', async () => {
    const { organizer, event } = await setupEvent();
    const res = await api()
      .post(`/api/v1/events/${event._id}/banner`)
      .set(organizer.auth)
      .attach('banner', Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: 'b.png', contentType: 'image/png' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('UPLOADS_DISABLED');

    const wrongType = await api()
      .post(`/api/v1/events/${event._id}/banner`)
      .set(organizer.auth)
      .attach('banner', Buffer.from('hello'), { filename: 'b.txt', contentType: 'text/plain' });
    expect(wrongType.status).toBe(400);
  });
});

describe('ticket types', () => {
  it('creates free and paid tickets with price rules', async () => {
    const org = await createUser('organizer');
    const ev = await createEvent(org.user, { status: 'draft' });
    const url = `/api/v1/events/${ev._id}/tickets`;

    const free = await api().post(url).set(org.auth).send({ name: 'Free', kind: 'free', quantity: 20 });
    expect(free.status).toBe(201);
    expect(free.body.data).toMatchObject({ price: 0, sold: 0, currency: 'NGN' });

    const badFree = await api().post(url).set(org.auth).send({ name: 'Free+', kind: 'free', price: 100, quantity: 1 });
    expect(badFree.status).toBe(400);
    const badVip = await api().post(url).set(org.auth).send({ name: 'VIP', kind: 'vip', quantity: 1 });
    expect(badVip.status).toBe(400);

    const vip = await api().post(url).set(org.auth).send({ name: 'VIP', kind: 'vip', price: 2500000, quantity: 5 });
    expect(vip.status).toBe(201);
  });

  it('keeps total ticket quantity within capacity', async () => {
    const org = await createUser('organizer');
    const ev = await createEvent(org.user, { capacity: 10 });
    await createTicket(ev, { quantity: 8 });
    const res = await api()
      .post(`/api/v1/events/${ev._id}/tickets`)
      .set(org.auth)
      .send({ name: 'More', kind: 'free', quantity: 3 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAPACITY_EXCEEDED');
  });

  it('cannot lower quantity below sold or change price after sales', async () => {
    const { organizer, ticket } = await setupEvent({ ticket: { kind: 'regular', price: 1000, sold: 5 } });
    const low = await api().patch(`/api/v1/tickets/${ticket._id}`).set(organizer.auth).send({ quantity: 4 });
    expect(low.status).toBe(409);
    const price = await api().patch(`/api/v1/tickets/${ticket._id}`).set(organizer.auth).send({ price: 2000 });
    expect(price.body.error.code).toBe('TICKETS_SOLD');
    const ok = await api().patch(`/api/v1/tickets/${ticket._id}`).set(organizer.auth).send({ quantity: 6, name: 'Early' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ quantity: 6, name: 'Early' });
  });

  it('only the owner can add tickets', async () => {
    const { event } = await setupEvent();
    const other = await createUser('organizer');
    const res = await api()
      .post(`/api/v1/events/${event._id}/tickets`)
      .set(other.auth)
      .send({ name: 'X', kind: 'free', quantity: 1 });
    expect(res.status).toBe(403);
  });
});

describe('discovery', () => {
  let org;
  beforeEach(async () => {
    org = await createUser('organizer');
    const music = await createEvent(org.user, { title: 'Afrobeats Night', category: 'music', venue: { name: 'Club', city: 'Abuja' } });
    await createTicket(music, { kind: 'regular', price: 500000 });
    const tech = await createEvent(org.user, { title: 'Node Conference', category: 'tech', startAt: new Date(Date.now() + 3 * DAY), endAt: new Date(Date.now() + 3 * DAY + HOUR) });
    await createTicket(tech);
    await createEvent(org.user, { title: 'Secret Draft', status: 'draft' });
  });

  it('lists only published upcoming events with meta', async () => {
    const res = await api().get('/api/v1/events');
    expect(res.status).toBe(200);
    expect(res.body.data.map((e) => e.title)).toEqual(['Node Conference', 'Afrobeats Night']);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 2 });
  });

  it('filters by text, category, city, price and free', async () => {
    const titles = async (qs) => (await api().get(`/api/v1/events?${qs}`)).body.data.map((e) => e.title);
    expect(await titles('q=afrobeats')).toEqual(['Afrobeats Night']);
    expect(await titles('category=TECH')).toEqual(['Node Conference']);
    expect(await titles('city=abuja')).toEqual(['Afrobeats Night']);
    expect(await titles('isFree=true')).toEqual(['Node Conference']);
    expect(await titles('minPrice=100000')).toEqual(['Afrobeats Night']);
    expect(await titles('sort=-startAt')).toEqual(['Afrobeats Night', 'Node Conference']);
  });

  it('caps limit at 50 and paginates', async () => {
    expect((await api().get('/api/v1/events?limit=500')).status).toBe(400);
    const page2 = await api().get('/api/v1/events?limit=1&page=2');
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.meta).toEqual({ page: 2, limit: 1, total: 2 });
  });

  it('shows event details with ticket availability, hiding drafts from the public', async () => {
    const ev = await Event.findOne({ title: 'Node Conference' });
    const res = await api().get(`/api/v1/events/${ev.slug}`);
    expect(res.status).toBe(200);
    expect(res.body.data.ticketTypes[0]).toMatchObject({ quantity: 10, sold: 0, available: 10 });

    const draft = await Event.findOne({ status: 'draft' });
    expect((await api().get(`/api/v1/events/${draft.slug}`)).status).toBe(404);
    expect((await api().get(`/api/v1/events/${draft.slug}`).set(org.auth)).status).toBe(200);
  });
});
