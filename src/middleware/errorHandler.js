import { ZodError } from 'zod';
import mongoose from 'mongoose';
import multer from 'multer';
import AppError from '../utils/AppError.js';
import logger from '../config/logger.js';

function toAppError(err) {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    return AppError.badRequest('VALIDATION_ERROR', 'Request validation failed', details);
  }
  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
    return AppError.badRequest('VALIDATION_ERROR', 'Request validation failed', details);
  }
  if (err instanceof mongoose.Error.CastError) {
    return AppError.notFound('Resource');
  }
  if (err && err.code === 11000) {
    return AppError.conflict('DUPLICATE', 'A record with these details already exists');
  }
  if (err instanceof multer.MulterError) {
    return AppError.badRequest('UPLOAD_ERROR', err.message);
  }
  if (err && err.type === 'entity.parse.failed') {
    return AppError.badRequest('INVALID_JSON', 'Request body is not valid JSON');
  }
  if (err && err.type === 'entity.too.large') {
    return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }
  return null;
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  if (res.headersSent) {
    // A streamed response (e.g. CSV export) failed part-way; all we can do is stop.
    logger.error({ err, path: req.originalUrl }, 'Error after response started');
    return res.end();
  }
  const appErr = toAppError(err);
  if (!appErr) {
    logger.error({ err, path: req.originalUrl }, 'Unhandled error');
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', details: [] },
    });
  }
  return res.status(appErr.status).json({
    success: false,
    error: { code: appErr.code, message: appErr.message, details: appErr.details || [] },
  });
}

function notFound(req, _res, next) {
  next(new AppError(404, 'ROUTE_NOT_FOUND', `Route ${req.method} ${req.originalUrl} not found`));
}

export { errorHandler, notFound };
export default { errorHandler, notFound };
