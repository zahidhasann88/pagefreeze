import { chromium, type Browser, type BrowserContext, type LaunchOptions } from 'playwright';
export interface BrowserLauncher {
  launch(): Promise<Browser>;
}

export const playwrightLauncher: BrowserLauncher = {
  launch(options?: LaunchOptions) {
    return chromium.launch(options ?? {});
  },
} as unknown as BrowserLauncher;
export interface BrowserPoolOptions {
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
