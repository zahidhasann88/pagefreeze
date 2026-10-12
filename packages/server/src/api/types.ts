import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

/**
 * The Fastify instance type used across the API layer.
 *
 * The application is constructed with a pino `Logger` instance, which makes the instance
 * generic over that logger type. Declaring route registrars against the bare
 * `FastifyInstance` (whose default logger is the looser `FastifyBaseLogger`) would not be
 * assignable, so every route module uses this alias instead.
 */
export type AppInstance = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>;
