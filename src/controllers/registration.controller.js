import registrations from '../services/registration.service.js';
import payments from '../services/payment.service.js';
import checkin from '../services/checkin.service.js';
import { send, pageParams } from '../utils/http.js';

export const register = async (req, res) => {
  const { registration, checkoutUrl, httpStatus } = await registrations.register(
    req.user.id,
    req.params.id,
    req.body.ticketTypeId
  );
  const data = { registrationId: registration._id, status: registration.status };
  if (checkoutUrl) data.checkoutUrl = checkoutUrl;
  if (registration.holdExpiresAt) data.holdExpiresAt = registration.holdExpiresAt;
  if (registration.status === 'confirmed') {
    data.qrToken = registration.qrToken;
    data.qrUrl = `/api/v1/registrations/${registration._id}/qr`;
  }
  send(res, httpStatus, data);
};

export const cancel = async (req, res) => send(res, 200, await registrations.cancel(req.user, req.params.id));

// GET /registrations/:id/qr: the ticket QR as a PNG. Downloads by default; ?inline=true displays it.
export const qr = async (req, res) => {
  const { png, filename } = await registrations.ticketQr(req.user, req.params.id, req.query.size);
  res.set({
    'Content-Type': 'image/png',
    'Content-Length': png.length,
    'Content-Disposition': `${req.query.inline ? 'inline' : 'attachment'}; filename="${filename}"`,
    'Cache-Control': 'private, no-store', // it's an entry ticket; don't let shared caches keep it
  });
  res.send(png);
};

export const mine = async (req, res) => {
  const paging = pageParams(req.query);
  const { items, total } = await registrations.listForUser(req.user.id, { ...paging, status: req.query.status });
  send(res, 200, items, { page: paging.page, limit: paging.limit, total });
};

export const initializePayment = async (req, res) =>
  send(res, 200, await payments.initializeForUser(req.user.id, req.body.registrationId));

// Paystack expects a quick 200. Signature failures return 401 so they show up in its dashboard.
export const webhook = async (req, res) => {
  const result = await payments.handleWebhook(req.body, req.headers['x-paystack-signature']);
  send(res, 200, result);
};

export const checkIn = async (req, res) => {
  const reg = await checkin.checkIn(req.params.id, req.user, req.body.qrToken);
  send(res, 200, {
    registrationId: reg._id,
    status: reg.status,
    checkedInAt: reg.checkedInAt,
    attendee: reg.user,
    ticketType: reg.ticketType,
  });
};
