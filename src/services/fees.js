import env from '../config/env.js';

// Splits a ticket payment into the platform's commission and the organizer's share.
// The fee is fixed when checkout starts, so later rate changes never touch existing sales.
function splitPayment(amount) {
  if (!amount) return { platformFee: 0, organizerNet: 0 };
  const fee = Math.round((amount * env.PLATFORM_FEE_PERCENT) / 100) + env.PLATFORM_FEE_FLAT;
  const platformFee = Math.min(amount, fee);
  return { platformFee, organizerNet: amount - platformFee };
}

export { splitPayment };
export default { splitPayment };
