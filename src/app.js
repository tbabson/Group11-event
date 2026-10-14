import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import mongoSanitize from 'express-mongo-sanitize';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import env from './config/env.js';
import logger from './config/logger.js';
import openapi from './config/swagger.js';
import routes from './routes/index.js';
import * as regCtl from './controllers/registration.controller.js';
import { asyncHandler } from './utils/http.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';

// One short line per request ("GET /api/v1/events 200 12ms") instead of full header dumps.
function requestLogger() {
  return pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url.startsWith('/api/docs') },
    customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    customSuccessMessage: (req, res, ms) => `${req.method} ${req.originalUrl} ${res.statusCode} ${Math.round(ms)}ms`,
    customErrorMessage: (req, res) => `${req.method} ${req.originalUrl} ${res.statusCode}`,
    serializers: {
      req: (req) => ({ method: req.method, url: req.url }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  });
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render/Railway sit behind one proxy; needed for per-IP rate limits.

  if (env.NODE_ENV !== 'test') app.use(requestLogger());
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || env.CLIENT_ORIGINS.includes(origin)),
      credentials: true,
    })
  );

  // The webhook signature is computed over the exact bytes, so this route gets the raw body
  // and must be registered before the JSON parser.
  app.post('/api/v1/payments/webhook', express.raw({ type: '*/*', limit: '1mb' }), asyncHandler(regCtl.webhook));

  app.use(express.json({ limit: '100kb' }));
  app.use(mongoSanitize());

  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapi));
  app.get('/api/docs.json', (_req, res) => res.json(openapi));
  app.use('/api/v1', routes);
  app.get('/health', (_req, res) => res.redirect(307, '/api/v1/health'));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

export default createApp;
