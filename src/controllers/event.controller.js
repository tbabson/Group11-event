import events from '../services/event.service.js';
import tickets from '../services/ticket.service.js';
import { send, pageParams, parseSort } from '../utils/http.js';

const SORTABLE = ['startAt', 'createdAt', 'title'];

export const search = async (req, res) => {
  const paging = pageParams(req.query);
  const sort = parseSort(req.query.sort, SORTABLE, { startAt: 1 });
  const { items, total } = await events.search(req.query, paging, sort);
  send(res, 200, items, { page: paging.page, limit: paging.limit, total });
};

export const getBySlug = async (req, res) => send(res, 200, await events.getBySlug(req.params.slug, req.user));
export const create = async (req, res) => send(res, 201, await events.create(req.user.id, req.body));
export const update = async (req, res) => send(res, 200, await events.update(req.params.id, req.user, req.body));
export const publish = async (req, res) => send(res, 200, await events.setPublished(req.params.id, req.user, true));
export const unpublish = async (req, res) => send(res, 200, await events.setPublished(req.params.id, req.user, false));
export const remove = async (req, res) => send(res, 200, await events.remove(req.params.id, req.user));
export const uploadBanner = async (req, res) => send(res, 200, await events.setBanner(req.params.id, req.user, req.file));

export const createTicket = async (req, res) => send(res, 201, await tickets.create(req.params.id, req.user, req.body));
export const updateTicket = async (req, res) => send(res, 200, await tickets.update(req.params.id, req.user, req.body));
