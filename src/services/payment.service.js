import env from '../config/env.js';
import logger from '../config/logger.js';
import Event from '../models/Event.js';
import Payment from '../models/Payment.js';
import Registration from '../models/Registration.js';
import AppError from '../utils/AppError.js';
import { randomToken } from '../utils/tokens.js';
import { withTransaction } from '../utils/transaction.js';
import paystack from './paystack.client.js';
import { claimSeats, cancelRegistration } from './inventory.service.js';
import { newQrToken } from './qr.service.js';
import notify from './notification.service.js';
import { splitPayment } from './fees.js';
import waitlist from './waitlist.service.js';
import payouts from './payout.service.js';
import ledger from './ledger.service.js';

class ReclaimRace extends Error {}

// waitlist.service imports this module too; the cycle is fine because both sides only
// use each other inside functions, never at load time.
const promoteWaitlist = (ticketTypeId) => waitlist.promoteNext(ticketTypeId);

// Tickets a payment covers: every registration of the order (older payments have just one).
const ticketsOf = (payment) => (payment.registrations?.length ? payment.registrations : [payment.registration]);

// Per-ticket share of a payment, used when one ticket of an order is refunded.
function shareOf(payment) {
  const quantity = payment.quantity || 1;
  return {
    amount: payment.unitAmount ?? Math.round(payment.amount / quantity),
    platformFee: Math.round((payment.platformFee || 0) / Math.max(1, quantity - (payment.refundedRegistrations?.length || 0))),
  };
}

// Creates one Paystack transaction for the pending tickets of an order and records the Payment.
// Accepts one registration id or an array (all for the same ticket type and buyer).
async function startCheckout(registrationIds) {
  const ids = [].concat(registrationIds);
  const reg = await Registration.findById(ids[0])
    .populate('user', 'email')
    .populate('ticketType', 'price currency');
  const quantity = ids.length;
  const unitAmount = reg.ticketType.price;
  const unitSplit = splitPayment(unitAmount); // the fee is per ticket, so refunds stay exact
  const reference = `REG-${reg._id}-${randomToken(4)}`;
  const { authorizationUrl } = await paystack.initializeTransaction({
    email: reg.user.email,
    amount: unitAmount * quantity,
    currency: reg.ticketType.currency,
    reference,
    callbackUrl: env.PAYSTACK_CALLBACK_URL,
    metadata: { registrationIds: ids.map(String), quantity },
  });
  const payment = await Payment.create({
    registration: reg._id,
    registrations: ids,
    quantity,
    unitAmount,
    event: reg.event,
    ticketType: reg.ticketType._id,
    reference,
    amount: unitAmount * quantity,
    platformFee: unitSplit.platformFee * quantity,
    organizerNet: unitSplit.organizerNet * quantity,
    currency: reg.ticketType.currency,
    checkoutUrl: authorizationUrl,
  });
  await ledger.record({
    user: reg.user._id,
    event: reg.event,
    registration: reg._id,
    payment: payment._id,
    type: 'ticket_payment',
    amount: payment.amount,
    currency: payment.currency,
    status: 'pending',
    reference,
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
  // Reuse an open checkout that covers this ticket (it may cover the rest of its order too).
  const existing = await Payment.findOne({
    $or: [{ registrations: reg._id }, { registration: reg._id }],
    ticketType: reg.ticketType,
    status: 'initialized',
  }).sort({ createdAt: -1 });
  // Demo links are rebuilt from the current APP_URL, so fixing a wrong APP_URL also fixes
  // pending checkouts. A demo link saved before switching to real Paystack can't be paid any
  // more (the demo pages are off), so a fresh checkout replaces it.
  const savedIsDemo = existing?.checkoutUrl?.includes('/payments/demo/checkout/');
  let checkoutUrl;
  let reference;
  if (existing?.checkoutUrl && !(savedIsDemo && !paystack.isDemo())) {
    reference = existing.reference;
    checkoutUrl = savedIsDemo ? paystack.demoCheckoutUrl(reference) : existing.checkoutUrl;
  } else {
    if (existing) {
      await Payment.updateOne({ _id: existing._id, status: 'initialized' }, { status: 'failed', processedAt: new Date() });
      await ledger.setStatus(existing.reference, 'failed', 'Replaced by a new checkout');
    }
    // A fresh checkout covers every ticket of the order that is still waiting for payment.
    const orderTickets = reg.order
      ? await Registration.find(
          { order: reg.order, user: reg.user, ticketType: reg.ticketType, status: 'pending', holdExpiresAt: { $gt: new Date() } },
          '_id'
        )
      : [reg];
    ({ checkoutUrl, reference } = await startCheckout(orderTickets.map((r) => r._id)));
  }
  return { registrationId: reg._id, checkoutUrl, reference, holdExpiresAt: reg.holdExpiresAt };
}

// Ledger rows for money handed back to the attendee, plus the matching commission reversal.
// `suffix` distinguishes per-ticket refunds of the same payment.
async function recordRefund(payment, amount, { note, suffix = '', registration = payment.registration, feeReversed = 0 } = {}) {
  const reg = await Registration.findById(registration, 'user');
  if (!reg) return;
  await ledger.record({
    user: reg.user,
    event: payment.event,
    registration,
    payment: payment._id,
    type: 'refund',
    amount,
    currency: payment.currency,
    status: 'success',
    reference: `${ledger.refundRef(payment.reference)}${suffix}`,
    note,
  });
  if (!suffix && !payment.refundedAmount) {
    // Nothing was refunded before: the whole sale is undone, so the commission row is reversed.
    await ledger.setStatus(ledger.feeRef(payment.reference), 'reversed', note || 'Ticket refunded');
  } else if (feeReversed > 0) {
    const event = await Event.findById(payment.event, 'organizer');
    await ledger.record({
      user: event.organizer,
      event: payment.event,
      registration,
      payment: payment._id,
      type: 'commission',
      gateway: 'internal',
      amount: feeReversed,
      currency: payment.currency,
      status: 'reversed',
      reference: `${ledger.feeRef(payment.reference)}${suffix || '_rest'}`,
      note: 'Platform fee returned with a refunded ticket',
    });
  }
}

// Refunds everything still unrefunded on a payment (all its remaining tickets).
async function refund(payment, note) {
  const remaining = payment.amount - (payment.refundedAmount || 0);
  if (remaining <= 0) return true;
  try {
    // Nothing refunded yet: refund the whole charge; otherwise just what's left of it.
    if (payment.refundedAmount) await paystack.refundTransaction(payment.reference, remaining);
    else await paystack.refundTransaction(payment.reference);
    const updated = await Payment.findOneAndUpdate(
      { _id: payment._id, status: 'success', refundedAmount: payment.refundedAmount || 0 },
      { status: 'refunded', refundedAt: new Date(), refundedAmount: payment.amount, platformFee: 0, organizerNet: 0 }
    );
    if (updated) await recordRefund(payment, remaining, { note, feeReversed: payment.platformFee });
    return true;
  } catch (err) {
    // The charge stays 'success'; operators can find it via this log line and refund manually.
    logger.error({ err, reference: payment.reference }, 'Refund failed, needs manual follow-up');
    return false;
  }
}

// Refunds one ticket of a payment. A single-ticket payment, or the last ticket left on an
// order, refunds the remainder in full; otherwise only this ticket's share goes back.
async function refundTicket(payment, registrationId) {
  const already = (payment.refundedRegistrations || []).some((r) => String(r) === String(registrationId));
  if (already) return true;
  const left = (payment.quantity || 1) - (payment.refundedRegistrations?.length || 0);
  if (left <= 1) return refund(payment);

  const share = shareOf(payment);
  try {
    await paystack.refundTransaction(payment.reference, share.amount);
    const updated = await Payment.findOneAndUpdate(
      { _id: payment._id, status: 'success', refundedRegistrations: { $ne: registrationId } },
      {
        $inc: { refundedAmount: share.amount, platformFee: -share.platformFee, organizerNet: -(share.amount - share.platformFee) },
        $push: { refundedRegistrations: registrationId },
      },
      { new: true }
    );
    if (updated) {
      await recordRefund(payment, share.amount, {
        suffix: `_${registrationId}`,
        registration: registrationId,
        feeReversed: share.platformFee,
        note: 'One ticket of the order refunded',
      });
    }
    return true;
  } catch (err) {
    logger.error({ err, reference: payment.reference, registrationId }, 'Ticket refund failed, needs manual follow-up');
    return false;
  }
}

// Refunds a ticket's share of every successful payment that covers it.
async function refundSuccessfulPayments(registrationId) {
  const payments = await Payment.find({
    $or: [{ registrations: registrationId }, { registration: registrationId }],
    status: 'success',
  });
  for (const p of payments) await refundTicket(p, registrationId);
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
        .then(() => recordRefund(payment, Number(data.amount), { note: 'Paid amount did not match the ticket price' }))
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

  await ledger.setStatus(reference, 'success');
  if (claimed.platformFee > 0) {
    const event = await Event.findById(claimed.event, 'organizer');
    await ledger.record({
      user: event.organizer,
      event: claimed.event,
      registration: claimed.registration,
      payment: claimed._id,
      type: 'commission',
      gateway: 'internal',
      amount: claimed.platformFee,
      currency: claimed.currency,
      status: 'success',
      reference: ledger.feeRef(reference),
      note: 'Platform fee on ticket sale',
    });
  }

  // Confirm every ticket of the order that is still waiting for this payment, each with its own QR.
  const ids = ticketsOf(claimed);
  const confirmedIds = [];
  for (const id of ids) {
    const done = await Registration.findOneAndUpdate(
      { _id: id, ticketType: claimed.ticketType, status: 'pending' },
      { $set: { status: 'confirmed', qrToken: newQrToken() }, $unset: { holdExpiresAt: 1 } },
      { new: true }
    );
    if (done) confirmedIds.push(done._id);
  }
  const leftover = ids.filter((id) => !confirmedIds.some((c) => String(c) === String(id)));

  // Holds that expired before the payment landed: take the seats back (all of them or none)
  // if they're free and the event is still going ahead.
  let reclaimedIds = [];
  if (leftover.length) {
    reclaimedIds = await withTransaction(async (session) => {
      const regs = await Registration.find({
        _id: { $in: leftover },
        ticketType: claimed.ticketType,
        status: 'cancelled',
        cancelReason: 'hold_expired',
      }).session(session);
      if (regs.length !== leftover.length) return [];
      const event = await Event.findById(claimed.event, 'status startAt').session(session);
      if (!event || event.status !== 'published' || event.startAt <= new Date()) return [];
      if (!(await claimSeats(claimed.ticketType, regs.length, session))) return [];
      for (const reg of regs) {
        const updated = await Registration.findOneAndUpdate(
          { _id: reg._id, status: 'cancelled' },
          { $set: { status: 'confirmed', qrToken: newQrToken() }, $unset: { cancelledAt: 1, cancelReason: 1 } },
          { new: true, session }
        );
        if (!updated) throw new ReclaimRace(); // aborts, rolling back the seat claims
      }
      return regs.map((r) => r._id);
    }).catch((err) => {
      if (err instanceof ReclaimRace) return [];
      throw err;
    });
  }

  const ticketIds = [...confirmedIds, ...reclaimedIds];
  if (ticketIds.length) await notify.tickets(ticketIds);

  // Anything we couldn't honour is refunded: the whole charge, or just the missing tickets.
  if (!ticketIds.length) {
    await refund(claimed);
    return { refunded: true };
  }
  const unpaidFor = leftover.filter((id) => !reclaimedIds.some((r) => String(r) === String(id)));
  let fresh = claimed;
  for (const id of unpaidFor) {
    await refundTicket(fresh, id);
    fresh = await Payment.findById(claimed._id);
  }
  return {
    confirmed: true,
    ...(reclaimedIds.length ? { reclaimed: true } : {}),
    ...(ids.length > 1 ? { tickets: ticketIds.length } : {}),
    ...(unpaidFor.length ? { refundedTickets: unpaidFor.length } : {}),
  };
}

async function onChargeFailed(reference) {
  const claimed = await Payment.findOneAndUpdate(
    { reference, status: 'initialized' },
    { status: 'failed', processedAt: new Date() },
    { new: true }
  );
  if (!claimed) return { duplicate: true };
  await ledger.setStatus(reference, 'failed');

  // Cancel the order's tickets that are still waiting on *this* payment and free their seats.
  let released = null;
  for (const id of ticketsOf(claimed)) {
    const before = await withTransaction((session) =>
      cancelRegistration({ _id: id, ticketType: claimed.ticketType }, ['pending'], 'payment_failed', session)
    );
    if (before) released = before;
  }
  if (released) {
    await notify.cancelled(released._id, 'payment failed');
    await promoteWaitlist(released.ticketType);
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

// POST /payments/verify: called by the callback page when the buyer returns from Paystack.
// Asks Paystack for the transaction's real status and applies it exactly as the webhook would,
// so tickets are confirmed even when the webhook is slow or not configured. Safe to repeat:
// a payment is only ever processed once.
async function verifyForUser(userId, reference) {
  const payment = await Payment.findOne({ reference }).populate('registration', 'user status');
  if (!payment || String(payment.registration?.user) !== String(userId)) throw AppError.notFound('Payment');

  if (payment.status === 'initialized' && !paystack.isDemo()) {
    const tx = await paystack.verifyTransaction(reference);
    if (tx.status === 'success') await onChargeSuccess(reference, tx);
    else if (tx.status === 'failed') await onChargeFailed(reference);
    // abandoned / ongoing / pending: the buyer hasn't finished paying, so nothing changes yet.
  }

  const ids = ticketsOf(payment);
  const [fresh, reg, confirmed] = await Promise.all([
    Payment.findById(payment._id, 'status'),
    Registration.findById(payment.registration._id, 'status event').populate('event', 'slug title'),
    Registration.countDocuments({ _id: { $in: ids }, status: { $in: ['confirmed', 'checked-in'] } }),
  ]);
  return {
    reference,
    paymentStatus: fresh.status,
    registrationId: reg._id,
    registrationIds: ids,
    registrationStatus: reg.status,
    quantity: ids.length,
    confirmedTickets: confirmed,
    event: reg.event,
  };
}

export { startCheckout, initializeForUser, handleWebhook, verifyForUser, refund, refundTicket, refundSuccessfulPayments, ticketsOf };
export default { startCheckout, initializeForUser, handleWebhook, verifyForUser, refund, refundTicket, refundSuccessfulPayments, ticketsOf };
