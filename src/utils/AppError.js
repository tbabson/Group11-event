class AppError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(code, message, details) {
    return new AppError(400, code, message, details);
  }

  static unauthorized(message = 'Authentication required', code = 'UNAUTHORIZED') {
    return new AppError(401, code, message);
  }

  static forbidden(message = 'You do not have permission to do this', code = 'FORBIDDEN') {
    return new AppError(403, code, message);
  }

  static notFound(what = 'Resource') {
    return new AppError(404, 'NOT_FOUND', `${what} not found`);
  }

  static conflict(code, message) {
    return new AppError(409, code, message);
  }
}

export default AppError;
