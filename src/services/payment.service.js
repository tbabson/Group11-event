import env from '../config/env.js';
import logger from '../config/logger.js';
import Event from '../models/Event.js';
import Payment from '../models/Payment.js';
import Registration from '../models/Registration.js';
import AppError from '../utils/AppError.js';
import { randomToken } from '../utils/tokens.js';
import { withTransaction } from '../utils/transaction.js';
import paystack from './paystack.client.js';
import { claimSeat, cancelRegistration } from './inventory.service.js';
import { newQrToken } from './qr.service.js';
import notify from './notification.service.js';
import { splitPayment } from './fees.js';
import waitlist from './waitlist.service.js';
import payouts from './payout.service.js';

class ReclaimRace extends Error {}

// waitlist.service imports this module too; the cycle is fine because both sides only
// use each other inside functions, never at load time.
const promoteWaitlist = (ticketTypeId) => waitlist.promoteNext(ticketTypeId);

// Creates a Paystack transaction for a pending registration and records the Payment.
async function startCheckout(registrationId) {
  const reg = await Registration.findById(registrationId)
    .populate('user', 'email')
    .populate('ticketType', 'price currency');
  const reference = `REG-${reg._id}-${randomToken(4)}`;
  const { authorizationUrl } = await paystack.initializeTransaction({
    email: reg.user.email,
    amount: reg.ticketType.price,
    currency: reg.ticketType.currency,
    reference,
    callbackUrl: `${env.CLIENT_ORIGINS[0]}/payments/callback`,
    metadata: { registrationId: String(reg._id) },
  });
  await Payment.create({
    registration: reg._id,
    event: reg.event,
    ticketType: reg.ticketType._id,
    reference,
    amount: reg.ticketType.price,
    ...splitPayment(reg.ticketType.price),
    currency: reg.ticketType.currency,
    checkoutUrl: authorizationUrl,
  });
  return { checkoutUrl: authorizationUrl, reference };
}

// POST /payments/initialize: returns a checkout URL for the user's own pending registration.
async function initializeForUser(userId, registrationId) {
  const reg = await Registration.findById(registrationId);
  if (!reg || String(reg.user) !== String(userId)) throw AppError.notFound('Registration');
  if (reg.status !== 'pending') {
    throw AppError.conflict('NOT_PENDING', 'This registration is not awaiting payment');
  }
  if (!reg.holdExpiresAt || reg.holdExpiresAt <= new Date()) {
    throw AppError.conflict('HOLD_EXPIRED', 'Your seat hold has expired');
  }
  // Reuse an open checkout only if it is for the ticket currently held (not one left over
  // from before the registration was cancelled and reused).
  const existing = await Payment.findOne({
    registration: reg._id,
    ticketType: reg.ticketType,
    status: 'initialized',
  }).sort({ createdAt: -1 });
  const { checkoutUrl, reference } = existing?.checkoutUrl
    ? existing
    : await startCheckout(reg._id);
  return { registrationId: reg._id, checkoutUrl, reference, holdExpiresAt: reg.holdExpiresAt };
}

async function refund(payment) {
  try {
    await paystack.refundTransaction(payment.reference);
    await Payment.updateOne({ _id: payment._id, status: 'success' }, { status: 'refunded', refundedAt: new Date() });
    return true;
  } catch (err) {
    // The charge stays 'success'; operators can find it via this log line and refund manually.
    logger.error({ err, reference: payment.reference }, 'Refund failed, needs manual follow-up');
    return false;
  }
}

async function refundSuccessfulPayments(registrationId) {
  const payments = await Payment.find({ registration: registrationId, status: 'success' });
  for (const p of payments) await refund(p);
}

async function onChargeSuccess(reference, data) {
  const payment = await Payment.findOne({ reference });
  if (!payment) return { ignored: true };

  if (Number(data.amount) !== payment.amount || (data.currency && data.currency !== payment.currency)) {
    logger.warn({ reference, got: data.amount, expected: payment.amount }, 'Payment amount mismatch');
    const result = await onChargeFailed(reference);
    // Money was taken for the wrong amount, so hand it back.
    if (!result.duplicate) {
      await paystack
        .refundTransaction(reference)
        .catch((err) => logger.error({ err, reference }, 'Refund of mismatched payment failed'));
    }
    return { ...result, amountMismatch: true };
  }

  // Idempotency: only the first webhook for a reference moves it out of 'initialized'.
  const claimed = await Payment.findOneAndUpdate(
    { reference, status: 'initialized' },
    { status: 'success', processedAt: new Date() },
    { new: true }
  );
  if (!claimed) return { duplicate: true };

  const qrToken = newQrToken();
  const confirmed = await Registration.findOneAndUpdate(
    { _id: payment.registration, ticketType: payment.ticketType, status: 'pending' },
    { $set: { status: 'confirmed', qrToken }, $unset: { holdExpiresAt: 1 } },
    { new: true }
  );
  if (confirmed) {
    await notify.ticket(confirmed._id);
    return { confirmed: true };
  }

  // The hold expired before the payment landed. Give the seat back if one is free
  // and the event is still going ahead; otherwise the charge is refunded below.
  const reclaimed = await withTransaction(async (session) => {
    const reg = await Registration.findOne({
      _id: payment.registration,
      ticketType: payment.ticketType,
      status: 'cancelled',
      cancelReason: 'hold_expired',
    }).session(session);
    if (!reg) return null;
    const event = await Event.findById(reg.event, 'status startAt').session(session);
    if (!event || event.status !== 'published' || event.startAt <= new Date()) return null;
    if (!(await claimSeat(reg.ticketType, session))) return null;
    const updated = await Registration.findOneAndUpdate(
      { _id: reg._id, status: 'cancelled' },
      { $set: { status: 'confirmed', qrToken }, $unset: { cancelledAt: 1, cancelReason: 1 } },
      { new: true, session }
    );
    if (!updated) throw new ReclaimRace(); // aborts, rolling back the seat claim
    return updated;
  }).catch((err) => {
    if (err instanceof ReclaimRace) return null;
    throw err;
  });
  if (reclaimed) {
    await notify.ticket(reclaimed._id);
    return { confirmed: true, reclaimed: true };
  }

  await refund(claimed);
  return { refunded: true };
}

async function onChargeFailed(reference) {
  const claimed = await Payment.findOneAndUpdate(
    { reference, status: 'initialized' },
    { status: 'failed', processedAt: new Date() },
    { new: true }
  );
  if (!claimed) return { duplicate: true };

  // Only cancel if the registration is still waiting on *this* ticket's payment.
  const before = await withTransaction((session) =>
    cancelRegistration(
      { _id: claimed.registration, ticketType: claimed.ticketType },
      ['pending'],
      'payment_failed',
      session
    )
  );
  if (before) {
    await notify.cancelled(before._id, 'payment failed');
    await promoteWaitlist(before.ticketType);
  }
  return { failed: true };
}

// POST /payments/webhook. rawBody must be the exact bytes Paystack sent.
async function handleWebhook(rawBody, signature) {
  if (!paystack.verifySignature(rawBody, signature)) {
    throw AppError.unauthorized('Invalid webhook signature', 'INVALID_SIGNATURE');
  }
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw AppError.badRequest('INVALID_JSON', 'Webhook body is not valid JSON');
  }
  const reference = event?.data?.reference;
  if (!reference) return { ignored: true };
  if (event.event === 'charge.success') return onChargeSuccess(reference, event.data);
  if (event.event === 'charge.failed') return onChargeFailed(reference);
  if (['transfer.success', 'transfer.failed', 'transfer.reversed'].includes(event.event)) {
    return payouts.handleTransferEvent(event.event, reference);
  }
  return { ignored: true };
}

export { startCheckout, initializeForUser, handleWebhook, refund, refundSuccessfulPayments };
export default { startCheckout, initializeForUser, handleWebhook, refund, refundSuccessfulPayments };
