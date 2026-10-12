import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { LIMITS, type Page } from '@pagefreeze/shared';
import { badRequest, validationError, zodDetails } from './errors.js';

/**
 * Small helpers that keep route handlers short and make the response envelope uniform.
 */

/** Validate with zod and turn a failure into a 422 carrying the field-level details. */
export function parseOrThrow<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw validationError('Request validation failed', zodDetails(result.error));
  }
  return result.data;
}

/** Validate a path/query parameter that must be a UUID. */
export function parseUuid(value: string, label = 'id'): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw badRequest(`${label} must be a UUID`);
  }
  return value;
}

export function sendPage<T>(
  reply: FastifyReply,
  page: { data: T[]; nextCursor: string | null },
): void {
  const body: Page<T> = {
    data: page.data,
    nextCursor: page.nextCursor,
    hasMore: page.nextCursor !== null,
  };
  void reply.send(body);
}

export function sendCreated<T>(reply: FastifyReply, body: T): void {
  void reply.status(201).send(body);
}

export function sendNoContent(reply: FastifyReply): void {
  void reply.status(204).send();
}

/** Clamp a user supplied limit into the documented range. */
export function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return LIMITS.pageSizeDefault;
  return Math.min(Math.max(1, Math.trunc(value)), LIMITS.pageSizeMax);
}

/**
 * Content disposition helper. Stored artefacts are always served as attachments or with
 * an explicit non-HTML content type, so a captured page can never execute in our origin.
 */
export function textResponse(reply: FastifyReply, body: string, contentType: string): void {
  void reply
    .header('content-type', `${contentType}; charset=utf-8`)
    .header('x-content-type-options', 'nosniff')
    .header('content-disposition', 'inline')
    .send(body);
}
