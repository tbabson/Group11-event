import { jest } from '@jest/globals';
import crypto from 'crypto';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import createApp from '../src/app.js';
import env from '../src/config/env.js';
import User from '../src/models/User.js';
import Event from '../src/models/Event.js';
import TicketType from '../src/models/TicketType.js';
import paystack from '../src/services/paystack.client.js';
import { signAccessToken } from '../src/services/auth.service.js';

const app = createApp();
const api = () => request(app);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
let seq = 0;

async function createUser(role = 'attendee', overrides = {}) {
  seq += 1;
  const user = await User.create({
    name: `${role} ${seq}`,
    email: `${role}${seq}-${Date.now()}@test.dev`,
    passwordHash: await bcrypt.hash('password123', 4),
    role,
    ...overrides,
  });
  return { user, token: signAccessToken(user), auth: { Authorization: `Bearer ${signAccessToken(user)}` } };
}

async function createEvent(organizer, overrides = {}) {
  seq += 1;
  return Event.create({
    organizer: organizer._id,
    title: `Event ${seq}`,
    slug: `event-${seq}-${Date.now()}`,
    category: 'tech',
    venue: { name: 'Hall', city: 'Lagos' },
    startAt: new Date(Date.now() + 7 * DAY),
    endAt: new Date(Date.now() + 7 * DAY + 4 * HOUR),
    capacity: 100,
    status: 'published',
    ...overrides,
  });
}

async function createTicket(event, overrides = {}) {
  return TicketType.create({
    event: event._id,
    name: 'General',
    kind: 'free',
    price: 0,
    quantity: 10,
    saleStart: new Date(Date.now() - DAY),
    saleEnd: new Date(event.startAt.getTime() - HOUR),
    ...overrides,
  });
}

// A published event with one ticket type, plus its organizer.
async function setupEvent({ ticket = {}, event = {} } = {}) {
  const organizer = await createUser('organizer');
  const ev = await createEvent(organizer.user, event);
  const tt = await createTicket(ev, ticket);
  return { organizer, event: ev, ticket: tt };
}

const paidTicket = (overrides = {}) => ({ name: 'VIP', kind: 'vip', price: 500000, ...overrides });

// Stubs Paystack's initialize call so no network is used.
function mockPaystack() {
  const init = jest
    .spyOn(paystack, 'initializeTransaction')
    .mockImplementation(async ({ reference }) => ({
      authorizationUrl: `https://checkout.paystack.com/${reference}`,
      reference,
    }));
  const refund = jest.spyOn(paystack, 'refundTransaction').mockResolvedValue({ status: 'pending' });
  return { init, refund };
}

function signedWebhook(body) {
  const raw = JSON.stringify(body);
  const signature = crypto.createHmac('sha512', env.PAYSTACK_SECRET_KEY).update(raw).digest('hex');
  return { raw, signature };
}

function sendWebhook(body, signature) {
  const signed = signedWebhook(body);
  return api()
    .post('/api/v1/payments/webhook')
    .set('Content-Type', 'application/json')
    .set('x-paystack-signature', signature ?? signed.signature)
    .send(signed.raw);
}

export { app, api, createUser, createEvent, createTicket, setupEvent, paidTicket, mockPaystack, signedWebhook, sendWebhook, HOUR, DAY };
export default { app, api, createUser, createEvent, createTicket, setupEvent, paidTicket, mockPaystack, signedWebhook, sendWebhook, HOUR, DAY };
