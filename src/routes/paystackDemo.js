// Demo Paystack checkout (PAYSTACK_MODE=demo only). The checkoutUrl returned at
// registration opens this page. "Pay" and "Decline" build the same signed webhook payload
// Paystack would send and run it through the real webhook handler, so confirmation, QR
// tickets, emails, refunds and waitlist promotion all behave as they would in production.
import express from 'express';
import env from '../config/env.js';
import Payment from '../models/Payment.js';
import AppError from '../utils/AppError.js';
import { asyncHandler as h, send } from '../utils/http.js';
import paystack from '../services/paystack.client.js';
import payments from '../services/payment.service.js';
import { escapeHtml } from '../services/notification.service.js';

const router = express.Router();

const naira = (kobo, currency) =>
  new Intl.NumberFormat('en-NG', { style: 'currency', currency: currency || 'NGN' }).format(kobo / 100);

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f4f6f8;margin:0;padding:24px 16px;color:#1b1f24}
  .card{max-width:420px;margin:40px auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
  .tag{display:inline-block;background:#fff4d6;color:#7a5b00;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600}
  h1{font-size:20px;margin:12px 0 4px} .amount{font-size:32px;font-weight:700;margin:16px 0}
  .muted{color:#5b6570;font-size:14px} form{display:inline} .row{display:flex;gap:12px;margin-top:20px}
  button{flex:1;border:0;border-radius:8px;padding:12px 16px;font-size:15px;font-weight:600;cursor:pointer}
  .pay{background:#0ba360;color:#fff} .fail{background:#e9ecef;color:#1b1f24}
  a{color:#0b6bcb}
</style></head><body><main class="card">${body}</main></body></html>`;

async function loadPayment(reference) {
  const payment = await Payment.findOne({ reference })
    .populate('event', 'title')
    .populate('ticketType', 'name')
    .populate({ path: 'registration', select: 'user', populate: { path: 'user', select: 'email' } });
  if (!payment) throw AppError.notFound('Payment');
  return payment;
}

router.get(
  '/checkout/:reference',
  h(async (req, res) => {
    const p = await loadPayment(req.params.reference);
    const ref = escapeHtml(p.reference);
    const action = `/api/v1/payments/demo/checkout/${encodeURIComponent(p.reference)}/complete`;
    const body =
      p.status === 'initialized'
        ? `<span class="tag">PAYSTACK DEMO · no real money</span>
<h1>${escapeHtml(p.event?.title)}</h1>
<div class="muted">${escapeHtml(p.ticketType?.name)} ticket · ${escapeHtml(p.registration?.user?.email)}</div>
<div class="amount">${naira(p.amount, p.currency)}</div>
<div class="muted">Reference: ${ref}</div>
<div class="row">
  <form method="post" action="${action}" style="flex:1;display:flex"><input type="hidden" name="outcome" value="success"><button class="pay" type="submit">Pay ${naira(p.amount, p.currency)}</button></form>
  <form method="post" action="${action}" style="flex:1;display:flex"><input type="hidden" name="outcome" value="failed"><button class="fail" type="submit">Decline</button></form>
</div>`
        : `<span class="tag">PAYSTACK DEMO</span><h1>Payment already ${escapeHtml(p.status)}</h1>
<div class="muted">Reference: ${ref}</div>`;
    res.type('html').send(page('Demo checkout', body));
  })
);

router.post(
  '/checkout/:reference/complete',
  express.urlencoded({ extended: false, limit: '10kb' }),
  h(async (req, res) => {
    const outcome = req.body?.outcome;
    if (!['success', 'failed'].includes(outcome)) {
      throw AppError.badRequest('VALIDATION_ERROR', 'outcome must be "success" or "failed"', [
        { field: 'outcome', message: 'must be "success" or "failed"' },
      ]);
    }
    const p = await loadPayment(req.params.reference);
    const raw = JSON.stringify({
      event: outcome === 'success' ? 'charge.success' : 'charge.failed',
      data: { reference: p.reference, amount: p.amount, currency: p.currency, status: outcome, channel: 'demo' },
    });
    const result = await payments.handleWebhook(Buffer.from(raw), paystack.sign(raw));

    if (!req.is('application/x-www-form-urlencoded')) return send(res, 200, { outcome, ...result });

    const back = `${env.CLIENT_ORIGINS[0]}/payments/callback?reference=${encodeURIComponent(p.reference)}`;
    let heading = 'Payment declined. Your seat has been released.';
    if (result.duplicate) heading = 'This payment was already processed.';
    else if (result.confirmed) heading = 'Payment successful. Your ticket is on its way by email.';
    else if (result.refunded) heading = 'Payment received, but your seat had expired, so it was refunded.';
    res
      .type('html')
      .send(
        page(
          'Demo checkout',
          `<span class="tag">PAYSTACK DEMO</span><h1>${escapeHtml(heading)}</h1>
<div class="muted">Reference: ${escapeHtml(p.reference)}</div>
<p><a href="${escapeHtml(back)}">Back to the app</a></p>`
        )
      );
  })
);

export default router;
