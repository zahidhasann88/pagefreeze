import { chromium, type Browser, type BrowserContext, type LaunchOptions } from 'playwright';

/**
 * BrowserLauncher is the seam tests use to inject a fake browser. The real
 * implementation wraps Playwright's Chromium.
 */
export interface BrowserLauncher {
  launch(): Promise<Browser>;
}

export const playwrightLauncher: BrowserLauncher = {
  launch(options?: LaunchOptions) {
    return chromium.launch(options ?? {});
  },
} as unknown as BrowserLauncher;

export interface BrowserPoolOptions {
  /** How many captures may run at once. Chromium is heavy; the default is deliberately low. */
  concurrency: number;
  launchOptions?: LaunchOptions;
  launcher?: BrowserLauncher;
  logger?: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
  };
}

interface QueueEntry {
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * One shared Chromium instance plus a semaphore that caps concurrent captures.
 *
 * Each capture gets a fresh, isolated `BrowserContext` (incognito-equivalent), so no
 * cookies, storage or cache are shared between monitors. Contexts are closed and
 * discarded after every capture.
 */
export class BrowserPool {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private active = 0;
  private readonly queue: QueueEntry[] = [];
  private closed = false;

  constructor(private readonly options: BrowserPoolOptions) {}

  get concurrency(): number {
    return this.options.concurrency;
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  isRunning(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }

  private getLauncher(): BrowserLauncher {
    return (
      this.options.launcher ??
      ({
        launch: () => chromium.launch(this.options.launchOptions ?? {}),
      } satisfies BrowserLauncher)
    );
  }

  async getBrowser(): Promise<Browser> {
    if (this.closed) throw new Error('browser pool is closed');
    if (this.browser && this.browser.isConnected()) return this.browser;

    if (this.launching) return this.launching;

    this.launching = (async () => {
      const launcher = this.getLauncher();
      const browser = await launcher.launch();
      browser.on('disconnected', () => {
        this.browser = null;
      });
      this.browser = browser;
      return browser;
    })();

    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  private async acquire(): Promise<void> {
    if (this.closed) throw new Error('browser pool is closed');
    if (this.active < this.options.concurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) {
      this.active += 1;
      next.resolve();
    }
  }

  /**
   * Run `task` with an isolated browser context, honouring the concurrency cap.
   * The context is always closed, even when the task throws.
   */
  async withContext<T>(
    task: (context: BrowserContext) => Promise<T>,
    contextOptions: Parameters<Browser['newContext']>[0] = {},
  ): Promise<T> {
    await this.acquire();
    let context: BrowserContext | null = null;
    try {
      const browser = await this.getBrowser();
      context = await browser.newContext(contextOptions);
      return await task(context);
    } finally {
      if (context) {
        await context.close().catch(() => undefined);
      }
      this.release();
    }
  }

  /** Cheap liveness probe used by /readyz. */
  async healthCheck(): Promise<boolean> {
    try {
      const browser = await this.getBrowser();
      return browser.isConnected();
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    while (this.queue.length > 0) {
      const entry = this.queue.shift();
      entry?.reject(new Error('browser pool is closing'));
    }
    const browser = this.browser;
    this.browser = null;
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}
