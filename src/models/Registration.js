import mongoose from 'mongoose';

const REG_STATUSES = ['pending', 'confirmed', 'waitlisted', 'cancelled', 'checked-in'];
// Registrations that count as "the user is registered" for duplicate checks.
const ACTIVE_STATUSES = ['pending', 'confirmed', 'waitlisted', 'checked-in'];

const registrationSchema = new mongoose.Schema(
  {
    event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
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

registrationSchema.index({ event: 1, user: 1 }, { unique: true });
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
