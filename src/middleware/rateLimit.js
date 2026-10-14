import rateLimit from 'express-rate-limit';
import env from '../config/env.js';

const make = (windowMs, max) =>
  rateLimit({
    windowMs,
    // Tests hammer these routes from one IP, so the limit is relaxed there.
    limit: env.NODE_ENV === 'test' ? 10000 : max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later', details: [] },
      }),
  });

const authLimiter = make(15 * 60 * 1000, 20);
const registerLimiter = make(60 * 1000, 10);

export { authLimiter, registerLimiter, make };
