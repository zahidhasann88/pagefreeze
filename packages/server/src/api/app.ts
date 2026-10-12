import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { Logger } from 'pino';
import type { AppInstance } from './types.js';
import type { AppDeps } from './deps.js';
import { errorHandler } from './errors.js';
import { registerSecurityHeaders } from './security.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerMonitorRoutes } from './routes/monitors.js';
import { registerSnapshotRoutes } from './routes/snapshots.js';
import { registerChangeRoutes } from './routes/changes.js';
import { registerChannelRoutes } from './routes/channels.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerShareRoutes } from './routes/share.js';
export interface BuildAppOptions {
  deps: AppDeps;
  logger: Logger;
  webDist?: string | null;
  disableRequestLogging?: boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<AppInstance> {
  const { deps, logger } = options;
  const config = deps.config;

  const app: AppInstance = Fastify({
    loggerInstance: logger,

    trustProxy: config.trustProxy,
    bodyLimit: config.bodyLimitBytes,

    disableRequestLogging: options.disableRequestLogging ?? true,
    genReqId: (request) =>
      (request.headers['x-request-id'] as string | undefined) ??
      `req-${Math.random().toString(36).slice(2, 10)}`,
  });

  app.setErrorHandler(errorHandler);

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      void reply.status(404).send({
        error: { code: 'not_found', message: `No route for ${request.method} ${request.url}` },
      });
      return;
    }

    const indexPath = options.webDist ? join(options.webDist, 'index.html') : null;
    if (indexPath && existsSync(indexPath)) {
      void reply.type('text/html').sendFile('index.html');
      return;
    }
    void reply.status(404).send({
      error: { code: 'not_found', message: 'Not found' },
    });
  });

  await app.register(cookie);

  await app.register(rateLimit, {
    global: false,
    max: 1000,
    timeWindow: '1 minute',
  });

  await registerSecurityHeaders(app, { hsts: config.secureCookies });

  app.options('*', (_request, reply) => {
    void reply.status(204).send();
  });

  await app.register(
    async (api) => {
      const scoped = api as unknown as AppInstance;
      await registerAuthRoutes(scoped, deps);
      await registerMonitorRoutes(scoped, deps);
      await registerSnapshotRoutes(scoped, deps);
      await registerChangeRoutes(scoped, deps);
      await registerChannelRoutes(scoped, deps);
      await registerSystemRoutes(scoped, deps);
      await registerShareRoutes(scoped, deps);
    },
    { prefix: '/api/v1' },
  );

  await registerSystemRoutes(app, deps);

  const webDist = options.webDist ?? findWebDist();
  if (webDist && existsSync(join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      wildcard: false,
      index: ['index.html'],

      setHeaders: (res, path) => {
        if (path.endsWith('index.html')) {
          res.setHeader('cache-control', 'no-cache');
        } else if (/\/assets\//.test(path)) {
          res.setHeader('cache-control', 'public, max-age=31536000, immutable');
        }
      },
    });
    logger.info({ webDist }, 'serving web ui');
  } else {
    logger.info('web ui build not found; serving API only');
  }

  return app;
}

export function findWebDist(): string | null {
  const explicit = process.env['PAGEFREEZE_WEB_DIST'];
  if (explicit) {
    const resolved = resolve(explicit);
    if (existsSync(join(resolved, 'index.html'))) return resolved;
  }

  const candidates = [
    resolve(process.cwd(), '../web/dist'),
    resolve(process.cwd(), 'packages/web/dist'),
    resolve(process.cwd(), 'public'),
    resolve(import.meta.dirname ?? process.cwd(), '../../../web/dist'),
    resolve(import.meta.dirname ?? process.cwd(), '../../public'),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}
