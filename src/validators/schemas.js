import { z } from 'zod';
import { MAX_LIMIT } from '../utils/http.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const idParams = z.object({ id: objectId });

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(20),
  sort: z.string().max(100).optional(),
};

const boolString = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

// ---- auth ----
const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8, 'Password must be at least 8 characters').max(128);

const auth = {
  register: z
    .object({
      name: z.string().trim().min(2).max(100),
      email,
      password,
      role: z.enum(['attendee', 'organizer']).default('attendee'),
    })
    .strict(),
  login: z.object({ email, password: z.string().min(1).max(128) }).strict(),
  refresh: z.object({ refreshToken: z.string().min(10) }).strict(),
  forgot: z.object({ email }).strict(),
  reset: z.object({ token: z.string().min(10).max(200), password }).strict(),
};

// ---- events ----
const venue = z
  .object({
    name: z.string().trim().max(200).optional(),
    address: z.string().trim().max(300).optional(),
    city: z.string().trim().max(100).optional(),
  })
  .strict();

const eventFields = z
  .object({
    title: z.string().trim().min(3).max(200),
    description: z.string().max(10000).optional(),
    category: z.string().trim().min(2).max(50),
    venue: venue.optional(),
    onlineUrl: z.string().url().max(500).optional(),
    startAt: z.coerce.date(),
    endAt: z.coerce.date(),
    capacity: z.coerce.number().int().min(1).max(1000000),
    refundPolicy: z.enum(['none', 'full']).optional(),
  })
  .strict();

const events = {
  create: eventFields
    .refine((e) => e.endAt > e.startAt, { message: 'endAt must be after startAt', path: ['endAt'] })
    .refine((e) => e.startAt > new Date(), { message: 'startAt must be in the future', path: ['startAt'] })
    .refine((e) => e.onlineUrl || e.venue?.name || e.venue?.address, {
      message: 'Provide a venue or an onlineUrl',
      path: ['venue'],
    }),
  update: eventFields
    .partial()
    .refine((e) => Object.keys(e).length > 0, { message: 'Provide at least one field to update' }),
  search: z.object({
    ...pagination,
    q: z.string().trim().max(100).optional(),
    category: z.string().trim().max(50).optional(),
    city: z.string().trim().max(100).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    when: z.enum(['upcoming', 'live', 'current']).default('upcoming'),
    minPrice: z.coerce.number().int().min(0).optional(),
    maxPrice: z.coerce.number().int().min(0).optional(),
    isFree: boolString,
  }),
  slugParams: z.object({ slug: z.string().min(1).max(120) }),
  adminStatus: z.object({ status: z.enum(['draft', 'published', 'cancelled', 'completed']) }).strict(),
};

// ---- tickets ----
const ticketFields = z
  .object({
    name: z.string().trim().min(1).max(100),
    kind: z.enum(['free', 'regular', 'vip']),
    price: z.coerce.number().int().min(0).optional(),
    currency: z.string().length(3).toUpperCase().default('NGN'),
    quantity: z.coerce.number().int().min(1),
    saleStart: z.coerce.date().optional(),
    saleEnd: z.coerce.date().optional(),
  })
  .strict();

const tickets = {
  create: ticketFields,
  update: ticketFields
    .omit({ currency: true })
    .partial()
    .refine((t) => Object.keys(t).length > 0, { message: 'Provide at least one field to update' }),
};

// ---- registrations, payments, check-in ----
const registrations = {
  register: z
    .object({
      ticketTypeId: objectId,
      quantity: z.coerce.number().int().min(1).max(100).default(1), // per-order cap enforced in the service
    })
    .strict(),
  qr: z.object({
    size: z.coerce.number().int().min(150).max(1000).default(400),
    inline: boolString,
  }),
  list: z.object({
    ...pagination,
    status: z.enum(['pending', 'confirmed', 'waitlisted', 'cancelled', 'checked-in']).optional(),
  }),
};

const reference = z.string().trim().min(5).max(100);

const payments = {
  initialize: z.object({ registrationId: objectId }).strict(),
  verify: z.object({ reference }).strict(),
};

// RepairHub-style /transactions routes.
const transactionFilters = {
  ...pagination,
  type: z.enum(['ticket_payment', 'commission', 'refund', 'payout']).optional(),
  status: z.enum(['pending', 'success', 'failed', 'reversed']).optional(),
};
const transactions = {
  verifyParams: z.object({ reference }),
  list: z.object(transactionFilters),
  adminList: z.object({ ...transactionFilters, event: objectId.optional(), user: objectId.optional() }),
};
const checkIn = z.object({ qrToken: z.string().trim().min(10).max(200) }).strict();

const PAYOUT_STATUSES = ['pending', 'awaiting_account', 'processing', 'paid', 'failed'];

const payouts = {
  account: z
    .object({
      bankCode: z.string().trim().regex(/^\d{3,10}$/, 'Bank code must be digits'),
      accountNumber: z.string().trim().regex(/^\d{10}$/, 'Account number must be 10 digits (NUBAN)'),
      accountName: z.string().trim().min(2).max(100),
    })
    .strict(),
  list: z.object({ ...pagination, status: z.enum(PAYOUT_STATUSES).optional() }),
};

const admin = {
  users: z.object({
    ...pagination,
    role: z.enum(['admin', 'organizer', 'attendee']).optional(),
    q: z.string().trim().max(100).optional(),
  }),
  revenue: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }),
  revenueByEvent: z.object({
    ...pagination,
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    q: z.string().trim().max(100).optional(),
    sort: z.enum(['gross', 'platformFees', 'payments', 'refunded', 'startAt']).default('gross'),
  }),
};

const myEvents = z.object({
  ...pagination,
  status: z.enum(['live', 'draft', 'completed', 'cancelled']).optional(),
  q: z.string().trim().max(100).optional(),
});

export { objectId, idParams, auth, events, tickets, registrations, payments, payouts, transactions, checkIn, admin, myEvents };
export default { objectId, idParams, auth, events, tickets, registrations, payments, payouts, transactions, checkIn, admin, myEvents };
