import mongoose from 'mongoose';

const ROLES = ['admin', 'organizer', 'attendee'];

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, default: 'attendee' },
    isVerified: { type: Boolean, default: false },
    // Where organizer payouts are sent. recipientCode comes from Paystack (or is simulated in demo mode).
    payoutAccount: {
      bankCode: String,
      accountNumber: String,
      accountName: String,
      recipientCode: String,
      updatedAt: Date,
    },
    passwordResetTokenHash: { type: String, select: false },
    passwordResetExpires: { type: Date, select: false },
  },
  { timestamps: true }
);

userSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.passwordHash;
    delete ret.passwordResetTokenHash;
    delete ret.passwordResetExpires;
    if (ret.payoutAccount?.accountNumber) {
      const { bankCode, accountNumber, accountName, updatedAt } = ret.payoutAccount;
      ret.payoutAccount = { bankCode, accountName, accountNumber: `******${accountNumber.slice(-4)}`, updatedAt };
    } else {
      delete ret.payoutAccount;
    }
    delete ret.__v;
    return ret;
  },
});

export default mongoose.model('User', userSchema);
export { ROLES };
