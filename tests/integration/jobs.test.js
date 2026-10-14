import { jest } from '@jest/globals';
import { createUser, setupEvent, paidTicket, HOUR, DAY } from '../helpers.js';
import Registration from '../../src/models/Registration.js';
import TicketType from '../../src/models/TicketType.js';
import Event from '../../src/models/Event.js';
import email from '../../src/services/email.service.js';
import { expireHolds, eventReminders, closeEvents } from '../../src/jobs/index.js';

describe('expireHolds', () => {
  it('cancels only expired pending holds and releases their seats', async () => {
    const { event, ticket } = await setupEvent({ ticket: paidTicket({ sold: 2 }) });
    const [a, b] = await Promise.all([createUser(), createUser()]);
    const expired = await Registration.create({ event: event._id, user: a.user._id, ticketType: ticket._id, status: 'pending', holdExpiresAt: new Date(Date.now() - 1000) });
    const fresh = await Registration.create({ event: event._id, user: b.user._id, ticketType: ticket._id, status: 'pending', holdExpiresAt: new Date(Date.now() + 60000) });

    expect(await expireHolds()).toBe(1);
    expect(await Registration.findById(expired._id)).toMatchObject({ status: 'cancelled', cancelReason: 'hold_expired' });
    expect((await Registration.findById(fresh._id)).status).toBe('pending');
    expect((await TicketType.findById(ticket._id)).sold).toBe(1);
    expect(await expireHolds()).toBe(0);
  });

  it('promotes the waitlist into released seats', async () => {
    const { event, ticket } = await setupEvent({ ticket: { quantity: 1, sold: 1 } });
    const [a, b] = await Promise.all([createUser(), createUser()]);
    await Registration.create({ event: event._id, user: a.user._id, ticketType: ticket._id, status: 'pending', holdExpiresAt: new Date(Date.now() - 1) });
    await Registration.create({ event: event._id, user: b.user._id, ticketType: ticket._id, status: 'waitlisted', waitlistedAt: new Date() });
    await expireHolds();
    expect((await Registration.findOne({ user: b.user._id })).status).toBe('confirmed');
    expect((await TicketType.findById(ticket._id)).sold).toBe(1);
  });
});

describe('eventReminders', () => {
  it('emails confirmed attendees of events in the next 24h exactly once', async () => {
    const soon = await setupEvent({ event: { startAt: new Date(Date.now() + 5 * HOUR), endAt: new Date(Date.now() + 8 * HOUR) } });
    const later = await setupEvent();
    const [a, b, c] = await Promise.all([createUser(), createUser(), createUser()]);
    await Registration.create({ event: soon.event._id, user: a.user._id, ticketType: soon.ticket._id, status: 'confirmed', qrToken: '1'.repeat(64) });
    await Registration.create({ event: soon.event._id, user: b.user._id, ticketType: soon.ticket._id, status: 'waitlisted' });
    await Registration.create({ event: later.event._id, user: c.user._id, ticketType: later.ticket._id, status: 'confirmed', qrToken: '2'.repeat(64) });

    expect(await eventReminders()).toBe(1);
    expect(await eventReminders()).toBe(0);
    await email.flush();
    const reminders = email.testOutbox.filter((m) => m.subject.startsWith('Reminder'));
    expect(reminders.map((m) => m.to)).toEqual([a.user.email]);
  });
});

describe('closeEvents', () => {
  it('completes ended events, which stops registration', async () => {
    const org = await createUser('organizer');
    const ended = await Event.create({ organizer: org.user._id, title: 'Past', slug: 'past', category: 'x', venue: { name: 'v' }, startAt: new Date(Date.now() - 2 * DAY), endAt: new Date(Date.now() - DAY), capacity: 5, status: 'published' });
    const { event: upcoming } = await setupEvent();
    expect(await closeEvents()).toBe(1);
    expect((await Event.findById(ended._id)).status).toBe('completed');
    expect((await Event.findById(upcoming._id)).status).toBe('published');
  });
});

describe('email queue', () => {
  it('retries failed sends with backoff and gives up after 3 attempts', async () => {
    const sendMail = jest.fn().mockRejectedValue(new Error('smtp down'));
    email._setTransporter({ sendMail });
    try {
      email.enqueue({ to: 'x@test.dev', subject: 'Hi', html: 'x' });
      await email.flush(0);
      expect(email.queue).toHaveLength(1);
      await email.flush(0); // not due yet
      expect(sendMail).toHaveBeenCalledTimes(1);
      await email.flush(Date.now() + 10 * 60 * 1000);
      await email.flush(Date.now() + 20 * 60 * 1000);
      expect(sendMail).toHaveBeenCalledTimes(3);
      expect(email.queue).toHaveLength(0);
    } finally {
      email._setTransporter(undefined);
    }
  });
});
