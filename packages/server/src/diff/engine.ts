import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import type { DiffRequest, DiffResult } from './types.js';
import { DEFAULT_DIFF_OPTIONS } from './types.js';
import { runDiffInProcess } from './runDiff.js';

export interface DiffEngine {
  diff(request: DiffRequest): Promise<DiffResult>;
  close(): Promise<void>;
}

/** Diffing on the calling thread. Used by tests and when `diffUseWorker` is off. */
export class InProcessDiffEngine implements DiffEngine {
  async diff(request: DiffRequest): Promise<DiffResult> {
    return runDiffInProcess(request);
  }

  async close(): Promise<void> {
    // nothing to do
  }
}

/**
 * Resolve the worker entry point.
 *
 * A compiled build runs `dist/diff/worker.js` directly. Under `tsx` (dev) or vitest the
 * source `.ts` file is used instead, with tsx registered through `--import`; if tsx
 * cannot be resolved the caller falls back to in-process diffing.
 */
export function resolveWorkerEntry(): { file: URL; execArgv: string[] } | null {
  const here = new URL('.', import.meta.url);
  const jsPath = new URL('worker.js', here);
  if (existsSync(jsPath)) return { file: jsPath, execArgv: [] };

  const tsPath = new URL('worker.ts', here);
  if (!existsSync(tsPath)) return null;

  try {
    const require = createRequire(import.meta.url);
    require.resolve('tsx');
  } catch {
    return null;
  }

  return { file: tsPath, execArgv: ['--import', 'tsx'] };
}

interface PendingCall {
  resolve: (value: DiffResult) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Runs diffing in a dedicated worker thread so the event loop stays responsive while
 * large screenshots are compared. The worker is started lazily and restarted once if it
 * dies; on repeated failure the engine degrades to in-process diffing rather than
 * dropping captures.
 */
export class WorkerDiffEngine implements DiffEngine {
  private worker: Worker | null = null;
  private pending: PendingCall | null = null;
  private starting: Promise<Worker> | null = null;
  private broken = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  private async ensureWorker(): Promise<Worker> {
    if (this.worker) return this.worker;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      const entry = resolveWorkerEntry();
      if (!entry) {
        this.broken = true;
        throw new Error('diff worker entry point could not be resolved');
      }

      const worker = new Worker(entry.file, { execArgv: entry.execArgv });
      worker.on(
        'message',
        (message: { ok: true; result: DiffResult } | { ok: false; error: string }) => {
          const call = this.pending;
          this.pending = null;
          if (!call) return;
          clearTimeout(call.timer);
          if (message.ok) {
            // Buffers survive structured clone as Uint8Array; restore the Buffer type.
            const result = message.result;
            if (result.diffImage && !Buffer.isBuffer(result.diffImage)) {
              result.diffImage = Buffer.from(result.diffImage);
            }
            call.resolve(result);
          } else {
            call.reject(new Error(message.error));
          }
        },
      );
      worker.on('error', (error) => {
        const call = this.pending;
        this.pending = null;
        if (call) {
          clearTimeout(call.timer);
          call.reject(error);
        }
        this.worker = null;
      });
      worker.on('exit', () => {
        this.worker = null;
        const call = this.pending;
        this.pending = null;
        if (call) {
          clearTimeout(call.timer);
          call.reject(new Error('diff worker exited before responding'));
        }
      });

      this.worker = worker;
      return worker;
    })();

    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  diff(request: DiffRequest): Promise<DiffResult> {
    const result = this.queue.then(() => this.execute(request));
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async execute(request: DiffRequest): Promise<DiffResult> {
    if (this.broken) return runDiffInProcess(request);

    try {
      const worker = await this.ensureWorker();

      return await new Promise<DiffResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending = null;
          reject(new Error(`diff worker timed out after ${this.timeoutMs}ms`));
          void worker.terminate();
        }, this.timeoutMs);

        this.pending = { resolve, reject, timer };

        const payload: DiffRequest = {
          ...request,
          options: { ...DEFAULT_DIFF_OPTIONS, ...request.options },
          beforeScreenshot: request.beforeScreenshot ? Buffer.from(request.beforeScreenshot) : null,
          afterScreenshot: request.afterScreenshot ? Buffer.from(request.afterScreenshot) : null,
        };
        worker.postMessage(payload);
      });
    } catch (error) {
      this.broken = true;
      await this.close();
      // Never lose a comparison because of worker plumbing.
      return runDiffInProcess(request);
    }
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    await worker.terminate().catch(() => undefined);
  }
}

export function createDiffEngine(useWorker: boolean): DiffEngine {
  return useWorker ? new WorkerDiffEngine() : new InProcessDiffEngine();
}
