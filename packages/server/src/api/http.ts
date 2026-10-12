import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { LIMITS, type Page } from '@pagefreeze/shared';
import { badRequest, validationError, zodDetails } from './errors.js';

export function parseOrThrow<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw validationError('Request validation failed', zodDetails(result.error));
  }
  return result.data;
}

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

export function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return LIMITS.pageSizeDefault;
  return Math.min(Math.max(1, Math.trunc(value)), LIMITS.pageSizeMax);
}

export function textResponse(reply: FastifyReply, body: string, contentType: string): void {
  void reply
    .header('content-type', `${contentType}; charset=utf-8`)
    .header('x-content-type-options', 'nosniff')
    .header('content-disposition', 'inline')
    .send(body);
}
