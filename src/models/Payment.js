import mongoose from 'mongoose';

// One Paystack charge. It can pay for several tickets bought together (an order):
// amount = unitAmount × quantity. Cancelling one ticket refunds just its share, tracked in
// refundedAmount/refundedRegistrations; the payment becomes 'refunded' once nothing is left.
const paymentSchema = new mongoose.Schema(
  {
    // First ticket of the order (kept for older code and data); `registrations` lists them all.
    registration: { type: mongoose.Schema.Types.ObjectId, ref: 'Registration', required: true, index: true },
    registrations: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Registration' }], index: true },
    quantity: { type: Number, default: 1, min: 1 },
    unitAmount: { type: Number },
    refundedAmount: { type: Number, default: 0 },
    refundedRegistrations: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Registration' }],
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
