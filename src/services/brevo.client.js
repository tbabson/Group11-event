// Minimal client for Brevo's transactional email API (POST /smtp/email).
// Exposes a nodemailer-style sendMail(message) so the email queue can use it as a transport.
import axios from 'axios';
import env from '../config/env.js';

const http = axios.create({ baseURL: env.BREVO_BASE_URL, timeout: 10000 });

// "Events <no-reply@x.com>" -> { name: 'Events', email: 'no-reply@x.com' }
function parseAddress(value) {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value || '');
  return match ? { name: match[1] || undefined, email: match[2] } : { email: String(value).trim() };
}

const toList = (to) => (Array.isArray(to) ? to : String(to).split(',')).map(parseAddress);

// Brevo's API has no inline (cid) images, so cid <img> tags are dropped and the
// files are sent as regular attachments instead.
const stripCidImages = (html) => (html || '').replace(/<img[^>]+src="cid:[^"]*"[^>]*>/gi, '');

function toPayload(message) {
  const payload = {
    sender: parseAddress(message.from || env.MAIL_FROM),
    to: toList(message.to),
    subject: message.subject,
    htmlContent: stripCidImages(message.html),
  };
  if (message.attachments?.length) {
    payload.attachment = message.attachments.map((a) => ({
      name: a.filename,
      content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : Buffer.from(a.content).toString('base64'),
    }));
  }
  return payload;
}

async function sendMail(message) {
  try {
    const { data } = await http.post('/smtp/email', toPayload(message), {
      headers: { 'api-key': env.BREVO_API_KEY, accept: 'application/json' },
    });
    return { messageId: data?.messageId };
  } catch (err) {
    // Re-throw a plain error: the axios error carries the request config, including the api-key header,
    // and would leak it into the logs.
    const status = err.response?.status ?? 'network';
    const detail = err.response?.data?.message || err.message;
    throw new Error(`Brevo send failed (${status}): ${detail}`);
  }
}

export { sendMail, toPayload, parseAddress, http };
export default { sendMail, toPayload, parseAddress, http };
