// /transactions routes, following RepairHub's payment layout:
//   POST /transactions/pay              start (or resume) checkout for a pending registration
//   GET  /transactions/verify/:reference  callback page asks the API to confirm with Paystack
//   POST /transactions/webhook/paystack   Paystack webhook (mounted in app.js, raw body)
//   GET  /transactions/me                 my ledger (payments/refunds, or commissions/payouts for organizers)
//   GET  /admin/transactions              full ledger for admins
import payments from '../services/payment.service.js';
import ledger from '../services/ledger.service.js';
import { send, pageParams } from '../utils/http.js';

export const pay = async (req, res) => send(res, 201, await payments.initializeForUser(req.user.id, req.body.registrationId));

export const verify = async (req, res) => send(res, 200, await payments.verifyForUser(req.user.id, req.params.reference));

function filtersFrom(query, base = {}) {
  const filter = { ...base };
  for (const key of ['type', 'status', 'event', 'user']) if (query[key]) filter[key] = query[key];
  return filter;
}

export const mine = async (req, res) => {
  const paging = pageParams(req.query);
  const { type, status } = req.query;
  const { items, total } = await ledger.list(filtersFrom({ type, status }, { user: req.user.id }), paging);
  send(res, 200, items, { page: paging.page, limit: paging.limit, total });
};

export const all = async (req, res) => {
  const paging = pageParams(req.query);
  const { items, total } = await ledger.list(filtersFrom(req.query), paging);
  send(res, 200, items, { page: paging.page, limit: paging.limit, total });
};
