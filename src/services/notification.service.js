// Builds and queues the emails the system sends. Failures here never break
// the request that triggered them.
import env from '../config/env.js';
import logger from '../config/logger.js';
import email from './email.service.js';
import { qrPng } from './qr.service.js';
import Registration from '../models/Registration.js';

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const when = (event) => new Date(event.startAt).toUTCString();
const where = (event) => (event.onlineUrl ? 'Online' : [event.venue?.name, event.venue?.city].filter(Boolean).join(', '));

async function loadRegistration(registrationId) {
  return Registration.findById(registrationId)
    .populate('user', 'name email')
    .populate('event', 'title startAt venue onlineUrl slug')
    .populate('ticketType', 'name');
}

async function safely(fn, context) {
  try {
    await fn();
  } catch (err) {
    logger.error({ err, ...context }, 'Failed to queue notification');
  }
}

const ticket = (registrationId) =>
  safely(async () => {
    const reg = await loadRegistration(registrationId);
    if (!reg || !reg.qrToken) return;
    const png = await qrPng(reg.qrToken);
    email.enqueue({
      to: reg.user.email,
      subject: `Your ticket: ${reg.event.title}`,
      html: `<p>Hi ${escapeHtml(reg.user.name)},</p>
<p>You're confirmed for <strong>${escapeHtml(reg.event.title)}</strong> (${escapeHtml(reg.ticketType.name)}).</p>
<p>When: ${when(reg.event)}<br>Where: ${escapeHtml(where(reg.event))}</p>
<p>Show this QR code at the entrance (it is also attached as ticket.png):</p><img src="cid:ticket-qr" alt="Ticket QR code">`,
      attachments: [{ filename: 'ticket.png', content: png, cid: 'ticket-qr' }],
    });
  }, { registrationId, kind: 'ticket' });

const waitlisted = (registrationId) =>
  safely(async () => {
    const reg = await loadRegistration(registrationId);
    if (!reg) return;
    email.enqueue({
      to: reg.user.email,
      subject: `You're on the waitlist: ${reg.event.title}`,
      html: `<p>Hi ${escapeHtml(reg.user.name)},</p><p>${escapeHtml(reg.ticketType.name)} tickets for <strong>${escapeHtml(
        reg.event.title
      )}</strong> are sold out. We'll email you if a seat opens up.</p>`,
    });
  }, { registrationId, kind: 'waitlisted' });

const paymentRequired = (registrationId, checkoutUrl) =>
  safely(async () => {
    const reg = await loadRegistration(registrationId);
    if (!reg) return;
    email.enqueue({
      to: reg.user.email,
      subject: `A seat opened up: ${reg.event.title}`,
      html: `<p>Hi ${escapeHtml(reg.user.name)},</p><p>A seat is being held for you at <strong>${escapeHtml(
        reg.event.title
      )}</strong> until ${new Date(reg.holdExpiresAt).toUTCString()}.</p><p><a href="${escapeHtml(
        checkoutUrl
      )}">Complete your payment</a> to confirm it.</p>`,
    });
  }, { registrationId, kind: 'paymentRequired' });

const cancelled = (registrationId, reason) =>
  safely(async () => {
    const reg = await loadRegistration(registrationId);
    if (!reg) return;
    email.enqueue({
      to: reg.user.email,
      subject: `Registration cancelled: ${reg.event.title}`,
      html: `<p>Hi ${escapeHtml(reg.user.name)},</p><p>Your registration for <strong>${escapeHtml(
        reg.event.title
      )}</strong> has been cancelled.${reason ? ` Reason: ${escapeHtml(reason)}.` : ''}</p>`,
    });
  }, { registrationId, kind: 'cancelled' });

const reminder = (registrationId) =>
  safely(async () => {
    const reg = await loadRegistration(registrationId);
    if (!reg) return;
    email.enqueue({
      to: reg.user.email,
      subject: `Reminder: ${reg.event.title} starts soon`,
      html: `<p>Hi ${escapeHtml(reg.user.name)},</p><p><strong>${escapeHtml(reg.event.title)}</strong> starts ${when(
        reg.event
      )}. Where: ${escapeHtml(where(reg.event))}. Bring your QR ticket.</p>`,
    });
  }, { registrationId, kind: 'reminder' });

const passwordReset = (user, token) =>
  safely(async () => {
    const link = `${env.CLIENT_ORIGINS[0]}/reset-password?token=${encodeURIComponent(token)}`;
    email.enqueue({
      to: user.email,
      subject: 'Reset your password',
      html: `<p>Hi ${escapeHtml(user.name)},</p><p><a href="${escapeHtml(
        link
      )}">Reset your password</a>. This link expires in 30 minutes. If you didn't ask for this, ignore this email.</p>`,
    });
  }, { userId: user._id, kind: 'passwordReset' });

export { ticket, waitlisted, paymentRequired, cancelled, reminder, passwordReset, escapeHtml };
export default { ticket, waitlisted, paymentRequired, cancelled, reminder, passwordReset, escapeHtml };
