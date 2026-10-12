import type { Database } from '../db/pool.js';
import * as queries from '../db/queries.js';
import type { Logger } from './captureJob.js';

/**
 * The subset of pg-boss the scheduler uses, expressed as an interface so tests can
 * inject a fake queue instead of a database.
 */
export interface JobQueue {
  start(): Promise<unknown>;
  stop(options?: { graceful?: boolean; timeout?: number }): Promise<void>;
  createQueue(name: string, options?: { policy?: string }): Promise<void>;
  schedule(name: string, cron: string, data?: object, options?: object): Promise<void>;
  unschedule(name: string): Promise<void>;
  getSchedules(): Promise<Array<{ name: string; cron: string }>>;
  deleteQueue(name: string): Promise<void>;
  send(name: string, data: object, options?: object): Promise<string | null>;
  work(
    name: string,
    options: object,
    handler: (jobs: Array<{ id: string; data: unknown }>) => Promise<unknown>,
  ): Promise<string>;
  offWork(name: string): Promise<void>;
  getQueueSize(name: string, options?: { before?: string }): Promise<number>;
}

export const CAPTURE_QUEUE_PREFIX = 'capture:';
export const RETENTION_QUEUE = 'retention';

export const captureQueueName = (monitorId: string): string =>
  `${CAPTURE_QUEUE_PREFIX}${monitorId}`;

export interface CaptureJobData {
  monitorId: string;
  /** True when a human pressed "capture now". */
  manual: boolean;
  enqueuedAt: string;
}

export interface SchedulerOptions {
  db: Database;
  queue: JobQueue;
  logger: Logger;
  /** Seconds between queue polls. Higher is cheaper; capture latency is cron-bound anyway. */
  pollingIntervalSeconds?: number;
  onCapture: (monitorId: string, data: CaptureJobData) => Promise<void>;
  onRetention: () => Promise<void>;
  /** Cron for the housekeeping job. */
  retentionCron?: string;
  retentionIntervalHours?: number;
  /** Singleton window (seconds) protecting against double-running a monitor. */
  singletonSeconds?: number;
}

/**
 * Scheduler.
 *
 * One pg-boss queue per monitor, each with its own cron schedule. That gives:
 *
 *   - one recurring job per enabled monitor, updated in place when the monitor changes
 *   - `singletonKey = monitorId`, so two server instances can never run the same monitor
 *     at the same time (pg-boss enforces this in Postgres with SKIP LOCKED)
 *   - disabling or deleting a monitor removes its schedule immediately
 *
 * `sync()` is the reconciliation entry point: it reads the monitors table and makes the
 * queue match. It is idempotent and cheap enough to run on every monitor mutation and
 * on startup.
 */
export class Scheduler {
  private readonly pollingIntervalSeconds: number;
  private readonly retentionCron: string;
  private readonly singletonSeconds: number;
  private readonly workers = new Set<string>();
  private lastRetentionAt = 0;
  private started = false;
  private stopping = false;

  constructor(private readonly options: SchedulerOptions) {
    this.pollingIntervalSeconds = options.pollingIntervalSeconds ?? 5;
    this.retentionCron = options.retentionCron ?? '17 * * * *';
    this.singletonSeconds = options.singletonSeconds ?? 300;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.options.queue.start();
    this.started = true;

    await this.options.queue.createQueue(RETENTION_QUEUE, { policy: 'singleton' });
    await this.options.queue.work(
      RETENTION_QUEUE,
      { pollingIntervalSeconds: 60, batchSize: 1 },
      async () => {
        try {
          const now = Date.now();
          const interval = (this.options.retentionIntervalHours ?? 0) * 3_600_000;
          if (this.lastRetentionAt && now - this.lastRetentionAt < interval) return;
          await this.options.onRetention();
          this.lastRetentionAt = now;
        } catch (error) {
          this.options.logger.error({ error: (error as Error).message }, 'retention job failed');
        }
      },
    );
    this.workers.add(RETENTION_QUEUE);

    await this.options.queue
      .schedule(
        RETENTION_QUEUE,
        this.retentionCron,
        { job: 'retention' },
        {
          singletonKey: RETENTION_QUEUE,
        },
      )
      .catch((error: Error) => {
        this.options.logger.warn({ error: error.message }, 'could not schedule retention job');
      });

    await this.sync();
  }

  /**
   * Make the queue match the monitors table:
   * create/update a schedule + worker for every enabled monitor, and remove the ones that
   * are disabled, paused or deleted.
   */
  async sync(): Promise<{ created: number; updated: number; removed: number }> {
    const monitors = await queries.listAllMonitorsForScheduling(this.options.db);
    const desired = new Map<string, string>();

    for (const monitor of monitors) {
      if (!monitor.enabled || monitor.paused) continue;
      desired.set(captureQueueName(monitor.id), monitor.scheduleCron);
    }

    let schedules: Array<{ name: string; cron: string }> = [];
    try {
      schedules = await this.options.queue.getSchedules();
    } catch (error) {
      this.options.logger.warn({ error: (error as Error).message }, 'could not read schedules');
    }
    const existing = new Map(
      schedules.filter((s) => s.name.startsWith(CAPTURE_QUEUE_PREFIX)).map((s) => [s.name, s.cron]),
    );

    let created = 0;
    let updated = 0;
    let removed = 0;

    // Remove schedules for monitors that are gone, disabled or paused.
    for (const [name, cron] of existing) {
      const want = desired.get(name);
      if (want === undefined) {
        await this.removeQueue(name);
        removed += 1;
        continue;
      }
      if (want !== cron || !this.workers.has(name)) {
        await this.registerQueue(name, want);
        if (want !== cron) updated += 1;
      }
      void cron;
    }

    // Add schedules for monitors that do not have one yet.
    for (const [name, cron] of desired) {
      if (existing.has(name)) continue;
      await this.registerQueue(name, cron);
      created += 1;
    }

    if (created + updated + removed > 0) {
      this.options.logger.info(
        { created, updated, removed, total: desired.size },
        'capture schedules reconciled',
      );
    }

    return { created, updated, removed };
  }

  private async registerQueue(name: string, cron: string): Promise<void> {
    if (this.stopping) return;

    const monitorId = name.slice(CAPTURE_QUEUE_PREFIX.length);

    await this.options.queue.createQueue(name, { policy: 'singleton' });

    if (!this.workers.has(name)) {
      await this.options.queue.work(
        name,
        { pollingIntervalSeconds: this.pollingIntervalSeconds, batchSize: 1 },
        async (jobs) => {
          for (const job of jobs) {
            const data = (job.data ?? {}) as Partial<CaptureJobData>;
            try {
              await this.options.onCapture(monitorId, {
                monitorId,
                manual: data.manual === true,
                enqueuedAt: data.enqueuedAt ?? new Date().toISOString(),
              });
            } catch (error) {
              this.options.logger.error(
                { monitorId, jobId: job.id, error: (error as Error).message },
                'capture job failed',
              );
            }
          }
        },
      );
      this.workers.add(name);
    }

    // `schedule` replaces the existing registration for this queue name.
    await this.options.queue.schedule(
      name,
      cron,
      { monitorId, manual: false },
      {
        singletonKey: monitorId,
        singletonSeconds: this.singletonSeconds,
      },
    );
  }

  /**
   * Tear down one monitor's queue.
   *
   * `offWork` is called unconditionally rather than only when *this* instance registered the
   * worker. Queue state lives in Postgres and is shared: in a multi-instance deployment the
   * instance that happens to observe a monitor being disabled is not necessarily the one
   * whose worker is attached, and skipping the call would leave that worker polling a queue
   * that no longer has a schedule. `offWork` is idempotent, so the unconditional call is
   * safe. Every step is wrapped because "already gone" is the normal case.
   */
  private async removeQueue(name: string): Promise<void> {
    try {
      await this.options.queue.unschedule(name);
    } catch {
      // already gone
    }
    try {
      await this.options.queue.offWork(name);
    } catch {
      // already gone
    }
    this.workers.delete(name);
    try {
      await this.options.queue.deleteQueue(name);
    } catch {
      // already gone
    }
  }

  /** Queue an immediate capture. Returns the pg-boss job id, or null when de-duplicated. */
  async enqueueCapture(monitorId: string, manual = true): Promise<string | null> {
    const name = captureQueueName(monitorId);

    // Make sure the queue and its worker exist even for a paused monitor: a manual
    // capture is always allowed.
    if (!this.workers.has(name)) {
      await this.registerQueue(name, '0 0 1 1 *');
      // The placeholder schedule would fire once a year; remove it so only manual and
      // reconciled schedules exist.
      await this.options.queue.unschedule(name).catch(() => undefined);
    }

    return this.options.queue.send(
      name,
      { monitorId, manual, enqueuedAt: new Date().toISOString() } satisfies CaptureJobData,
      {
        singletonKey: monitorId,
        priority: 10,
      },
    );
  }

  /** Total jobs waiting across every capture queue, for /metrics. */
  async queueDepth(): Promise<number> {
    try {
      const schedules = await this.options.queue.getSchedules();
      let total = 0;
      for (const schedule of schedules) {
        if (!schedule.name.startsWith(CAPTURE_QUEUE_PREFIX)) continue;
        total += await this.options.queue.getQueueSize(schedule.name, { before: 'retry' });
      }
      const retentionDepth = await this.options.queue.getQueueSize(RETENTION_QUEUE, {
        before: 'retry',
      });
      return total + retentionDepth;
    } catch {
      return 0;
    }
  }

  async stop(options: { timeoutMs?: number } = {}): Promise<void> {
    this.stopping = true;
    this.workers.clear();
    await this.options.queue
      .stop({ graceful: true, timeout: options.timeoutMs ?? 10_000 })
      .catch(() => undefined);
    this.started = false;
  }
}
