import PgBoss from 'pg-boss';
import type { JobQueue } from './scheduler.js';

/**
 * Adapter from pg-boss to the `JobQueue` interface the scheduler depends on.
 *
 * pg-boss is used rather than a bespoke polling loop because it already solves the hard
 * parts: exactly-once delivery via `SKIP LOCKED`, cron scheduling stored in Postgres, and
 * singleton keys. Using the same database for the queue also means there is no Redis to
 * operate, which is the whole point of a self-hosted single-container deployment.
 */
export interface PgBossQueueOptions {
  connectionString: string;
  /** Schema pg-boss creates for its own tables. Kept separate from the app schema. */
  schema?: string;
  /** Let pg-boss create/migrate its schema on start. */
  migrate?: boolean;
  supervisionIntervalSeconds?: number;
  logger?: { warn: (obj: unknown, msg?: string) => void };
}

export class PgBossQueue implements JobQueue {
  private readonly boss: PgBoss;

  constructor(options: PgBossQueueOptions) {
    this.boss = new PgBoss({
      connectionString: options.connectionString,
      schema: options.schema ?? 'pgboss',
      supervise: true,
      migrate: options.migrate ?? true,
      maintenanceIntervalSeconds: options.supervisionIntervalSeconds ?? 120,
      // Completed jobs are pruned quickly: capture history lives in our own tables, the
      // queue is only a dispatch mechanism.
      retentionDays: 1,
      monitoring: false,
    } as never);

    this.boss.on('error', (error: Error) => {
      options.logger?.warn({ error: error.message }, 'pg-boss error');
    });
  }

  async start(): Promise<unknown> {
    return this.boss.start();
  }

  async stop(options?: { graceful?: boolean; timeout?: number }): Promise<void> {
    await this.boss.stop({
      graceful: options?.graceful ?? true,
      timeout: options?.timeout ?? 10_000,
    });
  }

  async createQueue(name: string, options?: { policy?: string }): Promise<void> {
    await this.boss.createQueue(name, options as never);
  }

  async schedule(name: string, cron: string, data?: object, options?: object): Promise<void> {
    await this.boss.schedule(name, cron, data ?? {}, options as never);
  }

  async unschedule(name: string): Promise<void> {
    await this.boss.unschedule(name);
  }

  async getSchedules(): Promise<Array<{ name: string; cron: string }>> {
    const schedules = await this.boss.getSchedules();
    return schedules.map((schedule) => ({ name: schedule.name, cron: schedule.cron }));
  }

  async deleteQueue(name: string): Promise<void> {
    await this.boss.deleteQueue(name);
  }

  async send(name: string, data: object, options?: object): Promise<string | null> {
    return this.boss.send(name, data, options as never);
  }

  async work(
    name: string,
    options: object,
    handler: (jobs: Array<{ id: string; data: unknown }>) => Promise<unknown>,
  ): Promise<string> {
    return this.boss.work(name, options as never, handler as never);
  }

  async offWork(name: string): Promise<void> {
    await this.boss.offWork(name);
  }

  async getQueueSize(name: string, options?: { before?: string }): Promise<number> {
    return this.boss.getQueueSize(name, options as never);
  }
}
