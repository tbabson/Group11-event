import crypto from 'crypto';
import axios from 'axios';
import env from '../config/env.js';
import AppError from '../utils/AppError.js';

// PAYSTACK_MODE=demo (default) simulates Paystack: checkout links open a local demo page
// (see routes/paystackDemo.js) and refunds always succeed. PAYSTACK_MODE=live uses the real API.
const isDemo = () => env.PAYSTACK_MODE === 'demo';

const http = axios.create({ baseURL: env.PAYSTACK_BASE_URL, timeout: 10000 });
http.interceptors.request.use((config) => {
  config.headers.Authorization = `Bearer ${env.PAYSTACK_SECRET_KEY}`;
  return config;
});

function providerError(err) {
  const message = err.response?.data?.message || err.message;
  return new AppError(502, 'PAYMENT_PROVIDER_ERROR', `Payment provider error: ${message}`);
}

const demoCheckoutUrl = (reference) => `${env.APP_URL}/api/v1/payments/demo/checkout/${encodeURIComponent(reference)}`;

// Returns { authorizationUrl, reference }.
async function initializeTransaction({ email, amount, currency, reference, callbackUrl, metadata }) {
  if (isDemo()) return { authorizationUrl: demoCheckoutUrl(reference), reference };
  try {
    const { data } = await http.post('/transaction/initialize', {
      email,
      amount,
      currency,
      reference,
      callback_url: callbackUrl,
      metadata,
    });
    if (!data?.status) throw new Error(data?.message || 'initialize failed');
    return { authorizationUrl: data.data.authorization_url, reference: data.data.reference };
  } catch (err) {
    throw providerError(err);
  }
}

async function refundTransaction(reference) {
  if (isDemo()) return { transaction: reference, status: 'processed', demo: true };
  try {
    const { data } = await http.post('/refund', { transaction: reference });
    if (!data?.status) throw new Error(data?.message || 'refund failed');
    return data.data;
  } catch (err) {
    throw providerError(err);
  }
}

// Registers an organizer's bank account for transfers. Returns { recipientCode }.
async function createTransferRecipient({ name, accountNumber, bankCode, currency = 'NGN' }) {
  if (isDemo()) return { recipientCode: `RCP_demo_${crypto.randomBytes(6).toString('hex')}` };
  try {
    const { data } = await http.post('/transferrecipient', {
      type: 'nuban',
      name,
      account_number: accountNumber,
      bank_code: bankCode,
      currency,
    });
    if (!data?.status) throw new Error(data?.message || 'could not create recipient');
    return { recipientCode: data.data.recipient_code };
  } catch (err) {
    throw providerError(err);
  }
}

// Sends money from the platform's Paystack balance to an organizer.
// Returns { status: 'success' | 'pending' | ..., transferCode }. Live transfers usually
// finish later via transfer.success / transfer.failed webhooks.
async function initiateTransfer({ amount, recipient, reference, reason }) {
  if (isDemo()) return { status: 'success', transferCode: `TRF_demo_${reference}` };
  try {
    const { data } = await http.post('/transfer', { source: 'balance', amount, recipient, reference, reason });
    if (!data?.status) throw new Error(data?.message || 'transfer failed');
    return { status: data.data.status, transferCode: data.data.transfer_code };
  } catch (err) {
    throw providerError(err);
  }
}

const sign = (rawBody) => crypto.createHmac('sha512', env.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');

// Paystack signs the raw request body with HMAC-SHA512 using the secret key.
function verifySignature(rawBody, signature) {
  if (!signature || !rawBody) return false;
  const a = Buffer.from(sign(rawBody), 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export { initializeTransaction, refundTransaction, createTransferRecipient, initiateTransfer, verifySignature, sign, isDemo, http };
export default { initializeTransaction, refundTransaction, createTransferRecipient, initiateTransfer, verifySignature, sign, isDemo, http };
