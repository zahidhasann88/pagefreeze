import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, redactedConfig } from './config.js';
import { createLogger } from './logger.js';
import { createContext, type AppContext } from './context.js';
import { buildApp, findWebDist } from './api/app.js';
import { runMigrations } from './scripts/migrate.js';

export interface StartOptions {
  migrate?: boolean;
  disableBrowser?: boolean;
  disableScheduler?: boolean;
  noListen?: boolean;
  env?: Record<string, string | undefined>;
}
export interface StartedApp {
  context: AppContext;
  app: Awaited<ReturnType<typeof buildApp>>;
  url: string | null;
  close(): Promise<void>;
}

export async function start(options: StartOptions = {}): Promise<StartedApp> {
  const config = loadConfig(options.env ? { overrides: options.env } : {});
  const logger = createLogger({ level: config.logLevel });

  logger.info({ mode: config.mode, nodeEnv: config.nodeEnv }, 'starting pagefreeze');
  logger.debug({ config: redactedConfig(config) }, 'resolved configuration');

  if (options.migrate !== false) {
    await runMigrations({
      databaseUrl: config.databaseUrl,
      log: (message) => logger.info({ message }, 'migrate'),
    });
  }

  const context = await createContext({
    config,
    logger,
    ...(options.disableBrowser ? { disableBrowser: true } : {}),
    ...(options.disableScheduler ? { disableScheduler: true } : {}),
  });

  const app = await buildApp({
    deps: context.deps,
    logger,
    webDist: config.mode === 'worker' ? null : findWebDist(),
  });

  let url: string | null = null;

  const shouldListen = !options.noListen && config.mode !== 'worker';
  if (shouldListen) {
    url = await app.listen({ host: config.host, port: config.port });
    logger.info({ url, mode: config.mode }, 'pagefreeze listening');
  }

  if (context.scheduler) {
    await context.scheduler.start();
    logger.info('capture scheduler started');
  }

  if (context.browserPool && config.mode !== 'api') {
    context.browserPool
      .getBrowser()
      .then(() => logger.info('chromium ready'))
      .catch((error: Error) => logger.error({ error: error.message }, 'chromium failed to start'));
  }

  let closing: Promise<void> | null = null;

  const close = async (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      logger.info('shutting down');

      await app.close().catch(() => undefined);

      const grace = config.shutdownGraceMs;
      await Promise.race([
        context.shutdown(),
        new Promise<void>((resolve) => setTimeout(resolve, grace)),
      ]);

      logger.info('shutdown complete');
    })();
    return closing;
  };

  return { context, app, url, close };
}

async function main(): Promise<void> {
  let started: StartedApp | null = null;

  const onSignal = (signal: string): void => {
    if (!started) return;
    const app = started;
    started = null;
    app.context.logger.info({ signal }, 'received signal');
    void app.close().then(() => process.exit(0));

    const force = setTimeout(
      () => {
        console.error('forced exit after shutdown grace period');
        process.exit(1);
      },
      (app.context.config.shutdownGraceMs ?? 30_000) + 5_000,
    );
    force.unref();
  };

  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    console.error('unhandled rejection', reason);
  });

  started = await start();

  if (!started.url) {
    started.context.logger.info('running in worker mode; no HTTP listener');
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
    fileURLToPath(import.meta.url) === resolve(process.argv[1], '../dist/index.js'));

if (invokedDirectly || process.env['PAGEFREEZE_START'] === '1') {
  main().catch((error: unknown) => {
    console.error('fatal:', error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
