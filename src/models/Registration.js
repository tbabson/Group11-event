import mongoose from 'mongoose';

const REG_STATUSES = ['pending', 'confirmed', 'waitlisted', 'cancelled', 'checked-in'];
// Registrations that still hold (or wait for) a seat.
const ACTIVE_STATUSES = ['pending', 'confirmed', 'waitlisted', 'checked-in'];

// One registration = one ticket = one seat and one QR code. A person can hold several for
// the same event; tickets bought together share an `order` id and are paid in one Payment.
const registrationSchema = new mongoose.Schema(
  {
    event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    order: { type: mongoose.Schema.Types.ObjectId, index: true },
    ticketType: { type: mongoose.Schema.Types.ObjectId, ref: 'TicketType', required: true },
    status: { type: String, enum: REG_STATUSES, required: true },
    qrToken: { type: String },
    holdExpiresAt: Date,
    waitlistedAt: Date,
    checkedInAt: Date,
    cancelledAt: Date,
    cancelReason: {
      type: String,
      enum: ['user', 'organizer', 'hold_expired', 'payment_failed', 'event_cancelled'],
    },
    reminderSentAt: Date,
  },
  { timestamps: true }
);

// Not unique any more: a person may buy several tickets for the same event. Existing
// databases still have the old unique index; config/db.js drops it at startup.
registrationSchema.index({ event: 1, user: 1 });
registrationSchema.index({ qrToken: 1 }, { unique: true, sparse: true });
registrationSchema.index({ ticketType: 1, status: 1, waitlistedAt: 1 });
registrationSchema.index({ status: 1, holdExpiresAt: 1 });

registrationSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.__v;
    return ret;
  },
});

export default mongoose.model('Registration', registrationSchema);
export { REG_STATUSES };
export { ACTIVE_STATUSES };
