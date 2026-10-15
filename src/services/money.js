// MongoDB aggregation expressions for a Payment's money after refunds. A payment can be
// partly refunded (one ticket of an order) while staying 'success', so totals use these
// instead of the raw amount. Older fully refunded payments have no refundedAmount, which
// is why status 'refunded' is treated as "everything refunded".
const isRefunded = { $eq: ['$status', 'refunded'] };

// Money handed back to buyers.
const REFUNDED = { $cond: [isRefunded, '$amount', { $ifNull: ['$refundedAmount', 0] }] };
// Money the sale kept (gross after refunds).
const KEPT = { $subtract: ['$amount', REFUNDED] };
// Platform commission still earned (reduced as tickets are refunded).
const FEE = { $cond: [isRefunded, 0, { $ifNull: ['$platformFee', 0] }] };
// Organizer's share still owed.
const NET = { $cond: [isRefunded, 0, { $ifNull: ['$organizerNet', '$amount'] }] };
// Tickets refunded on this payment.
const REFUNDED_TICKETS = {
  $cond: [isRefunded, { $ifNull: ['$quantity', 1] }, { $size: { $ifNull: ['$refundedRegistrations', []] } }],
};
// Tickets the payment still pays for.
const KEPT_TICKETS = { $subtract: [{ $ifNull: ['$quantity', 1] }, REFUNDED_TICKETS] };

export { REFUNDED, KEPT, FEE, NET, REFUNDED_TICKETS, KEPT_TICKETS };
