import mongoose from 'mongoose';

// An organizer's earnings for one event (per currency), released after the hold period.
//   pending → processing → paid
//   pending → awaiting_account (organizer has no payout account yet) → processing → paid
//   processing → failed (an admin can retry)
const payoutSchema = new mongoose.Schema(
  {
    organizer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
    currency: { type: String, default: 'NGN' },
    grossAmount: { type: Number, default: 0 },
    platformFee: { type: Number, default: 0 },
    amount: { type: Number, default: 0 }, // what the organizer receives
    paymentCount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['pending', 'awaiting_account', 'processing', 'paid', 'failed'],
      default: 'pending',
      index: true,
    },
    // Paystack transfer reference for the current attempt (changes on retry).
    reference: { type: String, unique: true, sparse: true },
    transferCode: String,
    attempts: { type: Number, default: 0 },
    failureReason: String,
    demo: { type: Boolean, default: false },
    paidAt: Date,
  },
  { timestamps: true }
);

payoutSchema.index({ event: 1, currency: 1 }, { unique: true });

export default mongoose.model('Payout', payoutSchema);
