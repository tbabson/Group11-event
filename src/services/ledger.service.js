// Money ledger (the Transaction collection). The payment and payout flows call these
// helpers at each step. Writes are idempotent by reference, and a ledger failure is logged
// rather than thrown, so bookkeeping can never block a payment, refund or payout.
import logger from '../config/logger.js';
import Transaction from '../models/Transaction.js';

async function safely(fn, context) {
  try {
    return await fn();
  } catch (err) {
    logger.error({ err, ...context }, 'Ledger write failed');
    return null;
  }
}

// Inserts the row once; recording the same reference again changes nothing.
const record = (doc) =>
  safely(
    () => Transaction.updateOne({ reference: doc.reference }, { $setOnInsert: doc }, { upsert: true }),
    { reference: doc.reference, type: doc.type }
  );

// Moves a row to a new status (e.g. pending → success).
const setStatus = (reference, status, note) =>
  safely(() => Transaction.updateOne({ reference }, { $set: note ? { status, note } : { status } }), { reference, status });

const feeRef = (reference) => `${reference}_fee`;
const refundRef = (reference) => `${reference}_refund`;

async function list(filter, { limit, skip }) {
  const [items, total] = await Promise.all([
    Transaction.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .populate('event', 'title slug')
      .populate('user', 'name email role'),
    Transaction.countDocuments(filter),
  ]);
  return { items, total };
}

export { record, setStatus, feeRef, refundRef, list };
export default { record, setStatus, feeRef, refundRef, list };
