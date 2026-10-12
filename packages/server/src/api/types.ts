import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

export type AppInstance = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>;
