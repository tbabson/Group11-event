import { api, createUser, createEvent, createTicket, DAY, HOUR } from '../helpers.js';
import Payment from '../../src/models/Payment.js';
import Payout from '../../src/models/Payout.js';
import Registration from '../../src/models/Registration.js';
import { splitPayment } from '../../src/services/fees.js';

const past = (days) => ({ startAt: new Date(Date.now() - days * DAY - 3 * HOUR), endAt: new Date(Date.now() - days * DAY) });

describe('GET /me/events (organizer dashboard)', () => {
  let org;
  beforeEach(async () => {
    org = await createUser('organizer');
    const upcoming = await createEvent(org.user, { title: 'Upcoming gig' });
    await createTicket(upcoming, { kind: 'regular', price: 200000, quantity: 30, sold: 4 });
    await createTicket(upcoming, { name: 'Free', quantity: 10, sold: 6 });
    await createEvent(org.user, { title: 'Happening now', startAt: new Date(Date.now() - HOUR), endAt: new Date(Date.now() + HOUR) });
    await createEvent(org.user, { title: 'Draft one', status: 'draft' });
    await createEvent(org.user, { title: 'Draft two', status: 'draft' });
    await createEvent(org.user, { title: 'Done', status: 'completed', ...past(3) });
    await createEvent(org.user, { title: 'Ended, not yet closed', ...past(1) }); // still "published"
    await createEvent(org.user, { title: 'Called off', status: 'cancelled' });
    const other = await createUser('organizer');
    await createEvent(other.user, { title: 'Someone else' });
  });

  it('lists every one of my events, in any status, with correct counts', async () => {
    const res = await api().get('/api/v1/me/events?limit=50').set(org.auth);
    expect(res.status).toBe(200);
    expect(res.body.meta.summary).toEqual({ total: 7, live: 2, draft: 2, completed: 2, cancelled: 1 });
    expect(res.body.meta.total).toBe(7);
    expect(res.body.data.map((e) => e.title)).not.toContain('Someone else');
  });

  it('filters by dashboard bucket', async () => {
    const titles = async (status) =>
      (await api().get(`/api/v1/me/events?status=${status}`).set(org.auth)).body.data.map((e) => e.title).sort();
    expect(await titles('live')).toEqual(['Happening now', 'Upcoming gig']);
    expect(await titles('draft')).toEqual(['Draft one', 'Draft two']);
    expect(await titles('completed')).toEqual(['Done', 'Ended, not yet closed']);
    expect(await titles('cancelled')).toEqual(['Called off']);
  });

  it('adds ticket figures and keeps counts for the whole set when paginated', async () => {
    const res = await api().get('/api/v1/me/events?q=upcoming').set(org.auth);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ minPrice: 0, ticketsSold: 10, ticketsTotal: 40, ticketTypes: 2 });

    const page = await api().get('/api/v1/me/events?limit=2&page=2').set(org.auth);
    expect(page.body.data).toHaveLength(2);
    expect(page.body.meta).toMatchObject({ page: 2, limit: 2, total: 7 });
    expect(page.body.meta.summary.total).toBe(7);
  });

  it('admins see every event; attendees are refused', async () => {
    const admin = await createUser('admin');
    const res = await api().get('/api/v1/me/events').set(admin.auth);
    expect(res.body.meta.summary.total).toBe(8);
    const att = await createUser('attendee');
    expect((await api().get('/api/v1/me/events').set(att.auth)).status).toBe(403);
  });
});

describe('GET /admin/revenue/events', () => {
  let admin;
  let fest;
  let gala;

  async function sell(event, ticket, amount, status = 'success', processedAt = new Date()) {
    const att = await createUser('attendee');
    const reg = await Registration.create({ event: event._id, user: att.user._id, ticketType: ticket._id, status: 'confirmed' });
    return Payment.create({
      registration: reg._id,
      event: event._id,
      ticketType: ticket._id,
      reference: `R-${reg._id}`,
      amount,
      ...splitPayment(amount),
      status,
      processedAt,
    });
  }

  beforeEach(async () => {
    admin = await createUser('admin');
    const orgA = await createUser('organizer', { name: 'Ada Events' });
    const orgB = await createUser('organizer', { name: 'Bola Live' });
    fest = await createEvent(orgA.user, { title: 'Lagos Fest' });
    gala = await createEvent(orgB.user, { title: 'Charity Gala', status: 'completed', ...past(5) });
    const festVip = await createTicket(fest, { kind: 'vip', price: 500000 });
    const galaVip = await createTicket(gala, { kind: 'vip', price: 1000000 });
    await sell(fest, festVip, 500000);
    await sell(fest, festVip, 500000);
    await sell(fest, festVip, 500000, 'refunded');
    await sell(gala, galaVip, 1000000, 'success', new Date(Date.now() - 10 * DAY));
    await Payout.create({ organizer: orgB.user._id, event: gala._id, amount: 950000, status: 'paid', paidAt: new Date() });
    await createEvent(orgA.user, { title: 'Free meetup' }); // no payments: not listed
  });

  it('breaks revenue down per event with fees, refunds, organizer and payout state', async () => {
    const res = await api().get('/api/v1/admin/revenue/events').set(admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(2);
    const [first, second] = res.body.data;

    expect(first).toMatchObject({
      currency: 'NGN',
      event: { title: 'Lagos Fest', status: 'published', slug: fest.slug },
      organizer: { name: 'Ada Events' },
      gross: 1000000,
      platformFees: 50000,
      organizerNet: 950000,
      refunded: 500000,
      payments: 2,
      refunds: 1,
      payout: null,
      held: 950000,
    });
    expect(second).toMatchObject({
      event: { title: 'Charity Gala', status: 'completed' },
      organizer: { name: 'Bola Live' },
      gross: 1000000,
      platformFees: 50000,
      payments: 1,
      payout: { status: 'paid', amount: 950000 },
      held: 0,
    });
  });

  it('per-event fees add up to the platform total', async () => {
    const [perEvent, totals] = await Promise.all([
      api().get('/api/v1/admin/revenue/events').set(admin.auth),
      api().get('/api/v1/admin/revenue').set(admin.auth),
    ]);
    const sum = perEvent.body.data.reduce((n, r) => n + r.platformFees, 0);
    expect(sum).toBe(totals.body.data.revenue[0].platformFees);
  });

  it('supports sort, search, date range and pagination', async () => {
    const titles = async (qs) => (await api().get(`/api/v1/admin/revenue/events?${qs}`).set(admin.auth)).body.data.map((r) => r.event.title);
    expect(await titles('sort=refunded')).toEqual(['Lagos Fest', 'Charity Gala']);
    expect(await titles('sort=startAt')).toEqual(['Lagos Fest', 'Charity Gala']);
    expect(await titles('q=gala')).toEqual(['Charity Gala']);
    expect(await titles(`from=${new Date(Date.now() - DAY).toISOString()}`)).toEqual(['Lagos Fest']);

    const page = await api().get('/api/v1/admin/revenue/events?limit=1&page=2').set(admin.auth);
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta).toEqual({ page: 2, limit: 1, total: 2 });

    expect((await api().get('/api/v1/admin/revenue/events?sort=bogus').set(admin.auth)).status).toBe(400);
  });

  it('is admin only', async () => {
    const org = await createUser('organizer');
    expect((await api().get('/api/v1/admin/revenue/events').set(org.auth)).status).toBe(403);
  });
});
