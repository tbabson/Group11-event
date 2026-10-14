import mongoose from 'mongoose';

const paymentSchema = new mongoose.Schema(
  {
    registration: { type: mongoose.Schema.Types.ObjectId, ref: 'Registration', required: true, index: true },
    event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    // The ticket type this charge pays for. A registration can be reused with a different
    // ticket type after cancellation, so a payment only confirms the ticket it was made for.
    ticketType: { type: mongoose.Schema.Types.ObjectId, ref: 'TicketType' },
    provider: { type: String, enum: ['paystack'], default: 'paystack' },
    reference: { type: String, required: true, unique: true },
    amount: { type: Number, required: true },
    // Commission split, fixed at checkout: amount = platformFee + organizerNet.
    platformFee: { type: Number, default: 0 },
    organizerNet: { type: Number },
    // Set once the organizer's share of this payment has been included in a payout.
    payout: { type: mongoose.Schema.Types.ObjectId, ref: 'Payout', index: true },
    currency: { type: String, default: 'NGN' },
    status: { type: String, enum: ['initialized', 'success', 'failed', 'refunded'], default: 'initialized' },
    checkoutUrl: String,
    processedAt: Date,
    refundedAt: Date,
  },
  { timestamps: true }
);

export default mongoose.model('Payment', paymentSchema);
