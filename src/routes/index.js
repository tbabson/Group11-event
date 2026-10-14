import express from 'express';
import mongoose from 'mongoose';
import { requireAuth, optionalAuth, requireRole } from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { authLimiter, registerLimiter } from '../middleware/rateLimit.js';
import { bannerUpload } from '../middleware/upload.js';
import { asyncHandler as h, send } from '../utils/http.js';
import s from '../validators/schemas.js';
import * as authCtl from '../controllers/auth.controller.js';
import * as eventCtl from '../controllers/event.controller.js';
import * as regCtl from '../controllers/registration.controller.js';
import * as reportCtl from '../controllers/report.controller.js';
import * as payoutCtl from '../controllers/payout.controller.js';
import paystackDemo from './paystackDemo.js';
import paystack from '../services/paystack.client.js';
import AppError from '../utils/AppError.js';

const router = express.Router();
const organizer = [requireAuth, requireRole('organizer', 'admin')];
const withId = validate({ params: s.idParams });

router.get('/health', (_req, res) => {
  const dbUp = mongoose.connection.readyState === 1;
  send(res, dbUp ? 200 : 503, { status: dbUp ? 'ok' : 'degraded', db: dbUp ? 'up' : 'down', uptime: process.uptime() });
});

// ---- auth ----
const auth = express.Router();
auth.use(authLimiter);
auth.post('/register', validate({ body: s.auth.register }), h(authCtl.register));
auth.post('/login', validate({ body: s.auth.login }), h(authCtl.login));
auth.post('/refresh', validate({ body: s.auth.refresh }), h(authCtl.refresh));
auth.post('/logout', validate({ body: s.auth.refresh }), h(authCtl.logout));
auth.post('/forgot-password', validate({ body: s.auth.forgot }), h(authCtl.forgotPassword));
auth.post('/reset-password', validate({ body: s.auth.reset }), h(authCtl.resetPassword));
router.use('/auth', auth);

// ---- me ----
router.get('/me', requireAuth, h(authCtl.me));
router.get('/me/registrations', requireAuth, validate({ query: s.registrations.list }), h(regCtl.mine));
router.put('/me/payout-account', ...organizer, validate({ body: s.payouts.account }), h(payoutCtl.setAccount));
router.get('/me/payouts', ...organizer, validate({ query: s.payouts.list }), h(payoutCtl.mine));

// ---- events ----
router.get('/events', validate({ query: s.events.search }), h(eventCtl.search));
router.get('/events/:slug', optionalAuth, validate({ params: s.events.slugParams }), h(eventCtl.getBySlug));
router.post('/events', ...organizer, validate({ body: s.events.create }), h(eventCtl.create));
router.patch('/events/:id', ...organizer, withId, validate({ body: s.events.update }), h(eventCtl.update));
router.delete('/events/:id', ...organizer, withId, h(eventCtl.remove));
router.post('/events/:id/publish', ...organizer, withId, h(eventCtl.publish));
router.post('/events/:id/unpublish', ...organizer, withId, h(eventCtl.unpublish));
router.post('/events/:id/banner', ...organizer, withId, bannerUpload, h(eventCtl.uploadBanner));

// ---- tickets ----
router.post('/events/:id/tickets', ...organizer, withId, validate({ body: s.tickets.create }), h(eventCtl.createTicket));
router.patch('/tickets/:id', ...organizer, withId, validate({ body: s.tickets.update }), h(eventCtl.updateTicket));

// ---- registration ----
router.post(
  '/events/:id/register',
  requireAuth,
  requireRole('attendee'),
  registerLimiter,
  withId,
  validate({ body: s.registrations.register }),
  h(regCtl.register)
);
router.delete('/registrations/:id', requireAuth, withId, h(regCtl.cancel));
router.get('/registrations/:id/qr', requireAuth, withId, validate({ query: s.registrations.qr }), h(regCtl.qr));

// ---- payments (webhook is mounted in app.js because it needs the raw body) ----
router.post(
  '/payments/initialize',
  requireAuth,
  requireRole('attendee'),
  validate({ body: s.payments.initialize }),
  h(regCtl.initializePayment)
);

// Demo checkout page: only reachable when PAYSTACK_MODE=demo.
router.use(
  '/payments/demo',
  (_req, _res, next) => (paystack.isDemo() ? next() : next(AppError.notFound('Route'))),
  paystackDemo
);

// ---- check-in & reports ----
router.post('/events/:id/check-in', ...organizer, withId, validate({ body: s.checkIn }), h(regCtl.checkIn));
router.get('/events/:id/attendees.csv', ...organizer, withId, h(reportCtl.attendeesCsv));
router.get('/events/:id/attendees', ...organizer, withId, validate({ query: s.registrations.list }), h(reportCtl.attendees));
router.get('/events/:id/stats', ...organizer, withId, h(reportCtl.stats));

// ---- admin ----
const admin = express.Router();
admin.use(requireAuth, requireRole('admin'));
admin.get('/users', validate({ query: s.admin.users }), h(reportCtl.listUsers));
admin.patch('/events/:id/status', withId, validate({ body: s.events.adminStatus }), h(reportCtl.setEventStatus));
admin.get('/payouts', validate({ query: s.payouts.list }), h(payoutCtl.all));
admin.post('/payouts/:id/retry', withId, h(payoutCtl.retry));
admin.get('/revenue', validate({ query: s.admin.revenue }), h(payoutCtl.revenue));
router.use('/admin', admin);

export default router;
