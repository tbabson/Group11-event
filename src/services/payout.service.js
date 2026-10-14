// Organizer payouts. Paid-ticket money is held (Paystack keeps the funds; our ledger
// tracks whose they are) until PAYOUT_HOLD_DAYS after the event ends. Refunds and
// cancellations before that come out of the held amount, so the platform never has to
// claw money back from an organizer.
import env from '../config/env.js';
import logger from '../config/logger.js';
import Event from '../models/Event.js';
import Payment from '../models/Payment.js';
import Payout from '../models/Payout.js';
import User from '../models/User.js';
import AppError from '../utils/AppError.js';
import { withTransaction } from '../utils/transaction.js';
import paystack from './paystack.client.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NET = { $ifNull: ['$organizerNet', '$amount'] };

const availableAt = (event) => new Date(new Date(event.endAt).getTime() + env.PAYOUT_HOLD_DAYS * DAY_MS);

// ---- organizer payout account ----

async function setPayoutAccount(userId, { bankCode, accountNumber, accountName }) {
  const { recipientCode } = await paystack.createTransferRecipient({ name: accountName, accountNumber, bankCode });
  const user = await User.findByIdAndUpdate(
    userId,
    { payoutAccount: { bankCode, accountNumber, accountName, recipientCode, updatedAt: new Date() } },
    { new: true }
  );
  // Release anything that was waiting for an account.
  const waiting = await Payout.find({ organizer: userId, status: 'awaiting_account' });
  for (const p of waiting) await processPayout(p._id);
  return user;
}

// ---- payout creation and transfer ----

// Moves an event's settled payments into payouts (one per currency). Safe to repeat:
// payments already attached to a payout are skipped, and the unique {event, currency}
// index stops duplicates.
async function createPayoutsForEvent(event) {
  const currencies = await Payment.distinct('currency', { event: event._id, status: 'success', payout: null });
  const created = [];
  for (const currency of currencies) {
    if (await Payout.exists({ event: event._id, currency })) continue;
    try {
      const payout = await withTransaction(async (session) => {
        const [p] = await Payout.create([{ organizer: event.organizer, event: event._id, currency }], { session });
        await Payment.updateMany(
          { event: event._id, currency, status: 'success', payout: null },
          { payout: p._id },
          { session }
        );
        const [totals] = await Payment.aggregate([
          { $match: { payout: p._id } },
          { $group: { _id: null, gross: { $sum: '$amount' }, fee: { $sum: '$platformFee' }, net: { $sum: NET }, count: { $sum: 1 } } },
        ]).session(session);
        p.set({ grossAmount: totals.gross, platformFee: totals.fee, amount: totals.net, paymentCount: totals.count });
        await p.save({ session });
        return p;
      });
      created.push(payout);
    } catch (err) {
      if (err?.code === 11000) continue; // another run created it first
      throw err;
    }
  }
  return created;
}

// Sends (or retries) the transfer for a payout.
async function processPayout(payoutId) {
  const payout = await Payout.findOneAndUpdate(
    { _id: payoutId, status: { $in: ['pending', 'awaiting_account', 'failed'] } },
    { $set: { status: 'processing' }, $inc: { attempts: 1 } },
    { new: true }
  );
  if (!payout) return null;

  if (payout.amount <= 0) {
    payout.set({ status: 'paid', paidAt: new Date(), demo: paystack.isDemo() });
    return payout.save();
  }

  const organizer = await User.findById(payout.organizer);
  const recipient = organizer?.payoutAccount?.recipientCode;
  if (!recipient) {
    payout.status = 'awaiting_account';
    return payout.save();
  }

  // Paystack wants a fresh reference per attempt: lowercase, 16-50 chars.
  payout.reference = `payout_${payout._id}_${payout.attempts}`;
  await payout.save();
  try {
    const transfer = await paystack.initiateTransfer({
      amount: payout.amount,
      recipient,
      reference: payout.reference,
      reason: `Event payout ${payout.event}`,
    });
    payout.transferCode = transfer.transferCode;
    payout.demo = paystack.isDemo();
    if (transfer.status === 'success') payout.set({ status: 'paid', paidAt: new Date(), failureReason: undefined });
    return await payout.save();
  } catch (err) {
    payout.set({ status: 'failed', failureReason: err.message });
    logger.error({ err, payoutId: payout._id }, 'Payout transfer failed');
    return payout.save();
  }
}

// Cron: pays out every completed event whose hold period has passed.
async function releaseDuePayouts(now = new Date()) {
  const cutoff = new Date(now.getTime() - env.PAYOUT_HOLD_DAYS * DAY_MS);
  const events = await Event.find({ status: 'completed', endAt: { $lte: cutoff } }, '_id organizer endAt');
  let released = 0;
  for (const event of events) {
    for (const payout of await createPayoutsForEvent(event)) {
      const result = await processPayout(payout._id);
      if (result?.status === 'paid' || result?.status === 'processing') released += 1;
    }
  }
  return released;
}

// Webhook: transfer.success / transfer.failed / transfer.reversed.
async function handleTransferEvent(type, reference) {
  const set =
    type === 'transfer.success'
      ? { status: 'paid', paidAt: new Date() }
      : { status: 'failed', failureReason: type === 'transfer.reversed' ? 'Transfer reversed' : 'Transfer failed' };
  const payout = await Payout.findOneAndUpdate({ reference, status: 'processing' }, set, { new: true });
  return payout ? { payout: payout.status } : { ignored: true };
}

async function retry(payoutId) {
  const payout = await Payout.findById(payoutId);
  if (!payout) throw AppError.notFound('Payout');
  if (!['failed', 'awaiting_account'].includes(payout.status)) {
    throw AppError.conflict('PAYOUT_NOT_RETRYABLE', `A ${payout.status} payout cannot be retried`);
  }
  return processPayout(payout._id);
}

// ---- reporting ----

// Money summary for one event: what was sold, the platform's cut, what the organizer earns,
// and how much of that is still held versus already paid out.
async function eventFinance(event) {
  const [rows, payouts] = await Promise.all([
    Payment.aggregate([
      { $match: { event: event._id, status: { $in: ['success', 'refunded'] } } },
      {
        $group: {
          _id: { currency: '$currency', status: '$status' },
          gross: { $sum: '$amount' },
          fee: { $sum: '$platformFee' },
          net: { $sum: NET },
        },
      },
    ]),
    Payout.find({ event: event._id }, 'currency amount status paidAt'),
  ]);
  const byCurrency = {};
  for (const r of rows) {
    const c = (byCurrency[r._id.currency] ??= { currency: r._id.currency, gross: 0, platformFee: 0, organizerNet: 0, refunded: 0 });
    if (r._id.status === 'refunded') c.refunded += r.gross;
    else Object.assign(c, { gross: r.gross, platformFee: r.fee, organizerNet: r.net });
  }
  return Object.values(byCurrency).map((c) => {
    const payout = payouts.find((p) => p.currency === c.currency);
    return {
      ...c,
      held: payout ? 0 : c.organizerNet,
      payout: payout ? { status: payout.status, amount: payout.amount, paidAt: payout.paidAt } : null,
      availableAt: availableAt(event),
    };
  });
}

async function listPayouts(filter, { limit, skip }) {
  const [items, total] = await Promise.all([
    Payout.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('event', 'title slug endAt'),
    Payout.countDocuments(filter),
  ]);
  return { items, total };
}

// Platform earnings: fees on successful (non-refunded) payments, optionally within a date range.
async function platformRevenue({ from, to } = {}) {
  const match = { status: 'success' };
  if (from || to) {
    match.processedAt = {};
    if (from) match.processedAt.$gte = from;
    if (to) match.processedAt.$lte = to;
  }
  const [revenue, payoutTotals] = await Promise.all([
    Payment.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$currency',
          gross: { $sum: '$amount' },
          platformFees: { $sum: '$platformFee' },
          organizerNet: { $sum: NET },
          payments: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Payout.aggregate([{ $group: { _id: { currency: '$currency', status: '$status' }, amount: { $sum: '$amount' } } }]),
  ]);
  return {
    feePercent: env.PLATFORM_FEE_PERCENT,
    feeFlat: env.PLATFORM_FEE_FLAT,
    revenue: revenue.map(({ _id, ...rest }) => ({ currency: _id, ...rest })),
    payouts: payoutTotals.map((p) => ({ currency: p._id.currency, status: p._id.status, amount: p.amount })),
  };
}

export { setPayoutAccount, createPayoutsForEvent, processPayout, releaseDuePayouts, handleTransferEvent, retry, eventFinance, listPayouts, platformRevenue, availableAt };
export default { setPayoutAccount, createPayoutsForEvent, processPayout, releaseDuePayouts, handleTransferEvent, retry, eventFinance, listPayouts, platformRevenue, availableAt };
