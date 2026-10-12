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
  /** Directory holding the built SPA. When absent, only the API is served. */
  webDist?: string | null;
  /** Print every request. Off by default: it is noisy and leaks URLs into logs. */
  disableRequestLogging?: boolean;
}

/**
 * Build the Fastify application.
 *
 * Route registration order matters: `/monitors/preview` must come before
 * `/monitors/:id`, and the API prefix is registered before the SPA catch-all so that an
 * unknown `/api/...` path returns a JSON 404 rather than `index.html`.
 */
export async function buildApp(options: BuildAppOptions): Promise<AppInstance> {
  const { deps, logger } = options;
  const config = deps.config;

  const app: AppInstance = Fastify({
    loggerInstance: logger,
    // Behind a reverse proxy the client address must come from the forwarded header,
    // otherwise login rate limiting keys every request to the proxy.
    trustProxy: config.trustProxy,
    bodyLimit: config.bodyLimitBytes,
    // Request logging is off: URLs and query strings can carry sensitive values, and the
    // app logs what matters explicitly.
    disableRequestLogging: options.disableRequestLogging ?? true,
    // Serialise errors through our handler rather than Fastify's default shape.
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
    // Anything else is a client-side route: hand back the SPA shell.
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
    // In-memory by default. Documented in docs/configuration.md: with several API
    // instances each keeps its own counter, which is fine for abuse deterrence but is not
    // a global limit. Point PAGEFREEZE at a shared store if that matters.
  });

  await registerSecurityHeaders(app, { hsts: config.secureCookies });

  // A tiny no-op OPTIONS handler: the SPA is same-origin so browsers do not preflight,
  // but a curl probe or an embedded widget should not get a 404.
  app.options('*', (_request, reply) => {
    void reply.status(204).send();
  });

  // The encapsulated child instance is typed against Fastify's default logger, while this
  // app is built with an injected pino instance. The two are structurally identical at
  // runtime; the cast is confined to this one call site rather than loosening every route
  // module's signature.
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

  // Operational endpoints are also served at the root. Orchestrators, load balancers and
  // `docker compose` healthchecks conventionally probe /healthz and /readyz without a
  // version prefix, and /metrics is scraped the same way.
  await registerSystemRoutes(app, deps);

  // Serve the built SPA when it exists. `wildcard: false` plus the not-found handler
  // gives us history-API fallback without shadowing /api routes.
  const webDist = options.webDist ?? findWebDist();
  if (webDist && existsSync(join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      wildcard: false,
      index: ['index.html'],
      // Hashed asset filenames are immutable; index.html must always be revalidated.
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

/**
 * Locate the built frontend.
 *
 * Checked in order: an explicit `PAGEFREEZE_WEB_DIST`, the workspace layout used in
 * development, and the copy baked into the Docker image next to the server's `dist`.
 */
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
