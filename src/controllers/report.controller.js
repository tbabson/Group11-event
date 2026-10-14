import reports from '../services/report.service.js';
import admin from '../services/admin.service.js';
import { send, pageParams } from '../utils/http.js';

export const attendees = async (req, res) => {
  const paging = pageParams(req.query);
  const { items, total } = await reports.attendees(req.params.id, req.user, { ...paging, status: req.query.status });
  send(res, 200, items, { page: paging.page, limit: paging.limit, total });
};

export const stats = async (req, res) => send(res, 200, await reports.stats(req.params.id, req.user));

export const attendeesCsv = async (req, res) => {
  let started = false;
  await reports.writeAttendeesCsv(req.params.id, req.user, (chunk) => {
    if (!started) {
      // Headers go out only after the ownership check has passed.
      res.status(200);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="attendees-${req.params.id}.csv"`);
      started = true;
    }
    res.write(chunk);
  });
  res.end();
};

export const listUsers = async (req, res) => {
  const { items, total, page, limit } = await admin.listUsers({ ...pageParams(req.query), role: req.query.role, q: req.query.q });
  send(res, 200, items, { page, limit, total });
};

export const setEventStatus = async (req, res) => send(res, 200, await admin.setEventStatus(req.params.id, req.body.status));
