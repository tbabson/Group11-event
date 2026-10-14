// Wraps async route handlers so rejected promises reach the error handler.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function send(res, status, data, meta) {
  const body = { success: true, data };
  if (meta) body.meta = meta;
  return res.status(status).json(body);
}

const MAX_LIMIT = 50;

function pageParams(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

// Turns "-startAt,title" into { startAt: -1, title: 1 }, keeping only allowed fields.
function parseSort(sort, allowed, fallback) {
  if (!sort) return fallback;
  const out = {};
  for (const part of String(sort).split(',')) {
    const field = part.replace(/^-/, '').trim();
    if (allowed.includes(field)) out[field] = part.startsWith('-') ? -1 : 1;
  }
  return Object.keys(out).length ? out : fallback;
}

// Escapes user input for use inside a RegExp (prevents regex injection / ReDoS).
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export { asyncHandler, send, pageParams, parseSort, escapeRegex, MAX_LIMIT };
export default { asyncHandler, send, pageParams, parseSort, escapeRegex, MAX_LIMIT };
