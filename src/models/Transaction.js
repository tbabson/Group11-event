import mongoose from 'mongoose';

// Ledger of every money movement, one row each:
//   ticket_payment  attendee pays for a ticket (pending → success | failed)
//   commission      platform's cut of a successful ticket payment (success → reversed on refund)
//   refund          money returned to the attendee
//   payout          organizer's earnings transferred after the hold period (pending → success | failed)
// `user` is whose ledger the row belongs to: the attendee for payments/refunds, the organizer
// for commissions/payouts. Amounts are in the smallest currency unit (kobo), like Payment.
const TYPES = ['ticket_payment', 'commission', 'refund', 'payout'];
const STATUSES = ['pending', 'success', 'failed', 'reversed'];

const transactionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event' },
    registration: { type: mongoose.Schema.Types.ObjectId, ref: 'Registration' },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
    payout: { type: mongoose.Schema.Types.ObjectId, ref: 'Payout' },
    type: { type: String, enum: TYPES, required: true },
    gateway: { type: String, enum: ['paystack', 'internal'], default: 'paystack' },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'NGN' },
    status: { type: String, enum: STATUSES, default: 'pending' },
    // Unique per movement, so recording the same movement twice is a no-op.
    reference: { type: String, required: true },
    note: String,
  },
  { timestamps: true }
);

transactionSchema.index({ reference: 1 }, { unique: true });
transactionSchema.index({ user: 1, createdAt: -1 });
transactionSchema.index({ type: 1, status: 1 });
transactionSchema.index({ event: 1 });

export default mongoose.model('Transaction', transactionSchema);
export { TYPES as TRANSACTION_TYPES, STATUSES as TRANSACTION_STATUSES };
