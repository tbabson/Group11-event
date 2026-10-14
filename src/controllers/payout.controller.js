import payouts from '../services/payout.service.js';
import { send, pageParams } from '../utils/http.js';

export const setAccount = async (req, res) => send(res, 200, await payouts.setPayoutAccount(req.user.id, req.body));

const list = (scope) => async (req, res) => {
  const paging = pageParams(req.query);
  const filter = scope(req);
  if (req.query.status) filter.status = req.query.status;
  const { items, total } = await payouts.listPayouts(filter, paging);
  send(res, 200, items, { page: paging.page, limit: paging.limit, total });
};

export const mine = list((req) => ({ organizer: req.user.id }));
export const all = list(() => ({}));

export const retry = async (req, res) => send(res, 200, await payouts.retry(req.params.id));
export const revenue = async (req, res) => send(res, 200, await payouts.platformRevenue(req.query));

export const revenueByEvent = async (req, res) => {
  const paging = pageParams(req.query);
  const { from, to, q, sort } = req.query;
  const { items, total } = await payouts.revenueByEvent({ from, to, q, sort, ...paging });
  send(res, 200, items, { page: paging.page, limit: paging.limit, total });
};
