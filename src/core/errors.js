// Application error taxonomy. Handlers throw AppError subclasses; the HTTP
// layer maps them to responses. Anything else becomes an opaque 500 so
// internals (paths, stack traces) never leak to clients.

export class AppError extends Error {
  constructor(message, { status = 400, code = 'BAD_REQUEST', details = undefined, retryAfterSeconds = undefined } = {}) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
    this.expose = true;
  }
}

export class ValidationError extends AppError {
  constructor(message, details) {
    super(message, { status: 400, code: 'VALIDATION_ERROR', details });
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required.', code = 'UNAUTHENTICATED') {
    super(message, { status: 401, code });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource.', code = 'FORBIDDEN') {
    super(message, { status: 403, code });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found.') {
    super(message, { status: 404, code: 'NOT_FOUND' });
  }
}

export class ConflictError extends AppError {
  constructor(message, code = 'CONFLICT') {
    super(message, { status: 409, code });
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests. Try again later.', retryAfterSeconds = 60) {
    super(message, { status: 429, code: 'RATE_LIMITED', retryAfterSeconds });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'Request body too large.') {
    super(message, { status: 413, code: 'PAYLOAD_TOO_LARGE' });
  }
}
