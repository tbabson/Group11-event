import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import AppError from '../utils/AppError.js';

// Verifies the Bearer access token and sets req.user = { id, role }.
function requireAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(AppError.unauthorized());

  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
    req.user = { id: payload.sub, role: payload.role };
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(AppError.unauthorized('Access token expired', 'TOKEN_EXPIRED'));
    }
    return next(AppError.unauthorized('Invalid access token'));
  }
}

// Sets req.user when a valid token is present, but never rejects the request.
function optionalAuth(req, _res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Bearer' && token) {
    try {
      const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
      req.user = { id: payload.sub, role: payload.role };
    } catch {
      // Anonymous access is fine here.
    }
  }
  next();
}

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(AppError.unauthorized());
    if (!roles.includes(req.user.role)) return next(AppError.forbidden());
    return next();
  };
}

export { requireAuth, optionalAuth, requireRole };
export default { requireAuth, optionalAuth, requireRole };
