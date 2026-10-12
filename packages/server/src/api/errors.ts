import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

/**
 * Every API error is rendered as
 *
 *     { "error": { "code": "...", "message": "...", "details": ... } }
 *
 * `code` is machine readable and stable; `message` is safe to show a human. Internal
 * details (stack traces, SQL, file paths) are never included in a response.
 */

export type ErrorCode =
  | 'bad_request'
  | 'validation_error'
  | 'unauthorized'
  | 'forbidden'
  | 'csrf_failed'
  | 'not_found'
  | 'conflict'
  | 'unprocessable'
  | 'rate_limited'
  | 'payload_too_large'
  | 'internal';

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  toJSON(): { error: { code: ErrorCode; message: string; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export const badRequest = (message = 'Bad request', details?: unknown): AppError =>
  new AppError(400, 'bad_request', message, details);

export const validationError = (message: string, details?: unknown): AppError =>
  new AppError(422, 'validation_error', message, details);

export const unauthorized = (message = 'Authentication required'): AppError =>
  new AppError(401, 'unauthorized', message);

export const forbidden = (message = 'Not allowed'): AppError =>
  new AppError(403, 'forbidden', message);

export const csrfFailed = (message = 'CSRF validation failed'): AppError =>
  new AppError(403, 'csrf_failed', message);

export const notFound = (message = 'Not found'): AppError =>
  new AppError(404, 'not_found', message);

export const conflict = (message = 'Conflict'): AppError => new AppError(409, 'conflict', message);

export const rateLimited = (message = 'Too many requests'): AppError =>
  new AppError(429, 'rate_limited', message);

/** Flatten a ZodError into a compact, client-friendly list. */
export function zodDetails(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

const STATUS_FOR_CODE: Record<string, number> = {
  FST_ERR_CTP_EMPTY_JSON_BODY: 400,
  FST_ERR_JSON_CONTENT_TYPE_WITH_GZIP: 400,
  FST_REQ_TIMEOUT: 408,
};

/**
 * Fastify error handler.
 *
 * Recognised errors pass through unchanged. Everything else becomes a 500 with a generic
 * message; the real error is logged with its stack so it is debuggable server-side only.
 */
export function errorHandler(
  error: Error & { statusCode?: number; code?: string; validation?: unknown },
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof AppError) {
    void reply.status(error.status).send(error.toJSON());
    return;
  }

  if (error instanceof ZodError) {
    const appError = validationError('Request validation failed', zodDetails(error));
    void reply.status(appError.status).send(appError.toJSON());
    return;
  }

  // Fastify's own validation errors (params/query typed via JSON schema).
  if (error.validation) {
    const appError = validationError('Request validation failed', error.validation);
    void reply.status(appError.status).send(appError.toJSON());
    return;
  }

  const statusCode = error.statusCode ?? STATUS_FOR_CODE[error.code ?? ''] ?? undefined;

  if (statusCode === 413) {
    const appError = new AppError(413, 'payload_too_large', 'Request body is too large');
    void reply.status(appError.status).send(appError.toJSON());
    return;
  }

  if (statusCode === 429) {
    const appError = rateLimited(error.message || 'Too many requests');
    void reply.status(appError.status).send(appError.toJSON());
    return;
  }

  if (statusCode && statusCode >= 400 && statusCode < 500) {
    const appError = new AppError(statusCode, 'bad_request', error.message);
    void reply.status(appError.status).send(appError.toJSON());
    return;
  }

  request.log.error({ err: error, url: request.url }, 'unhandled error');
  const appError = new AppError(500, 'internal', 'Internal server error');
  void reply.status(appError.status).send(appError.toJSON());
}
