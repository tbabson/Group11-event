import mongoose from 'mongoose';

const ticketTypeSchema = new mongoose.Schema(
  {
    event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    name: { type: String, required: true, trim: true },
    kind: { type: String, enum: ['free', 'regular', 'vip'], required: true },
    // Price in the currency's smallest unit (kobo for NGN). Always 0 for free tickets.
    price: { type: Number, required: true, min: 0, default: 0 },
    currency: { type: String, default: 'NGN' },
    quantity: { type: Number, required: true, min: 1 },
    sold: { type: Number, default: 0, min: 0 },
    saleStart: { type: Date, required: true },
    saleEnd: { type: Date, required: true },
  },
  { timestamps: true }
);

ticketTypeSchema.virtual('isFree').get(function isFree() {
  return this.price === 0;
});

export default mongoose.model('TicketType', ticketTypeSchema);
