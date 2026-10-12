import { describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_QUEUE_PREFIX,
  RETENTION_QUEUE,
  Scheduler,
  captureQueueName,
  type CaptureJobData,
  type JobQueue,
} from '../../src/jobs/scheduler.js';
import { MetricsRegistry } from '../../src/metrics/registry.js';
import type { Database } from '../../src/db/pool.js';

/**
 * A JobQueue double that records everything done to it, so scheduling behaviour can be
 * asserted without a database or pg-boss.
 */
class FakeQueue implements JobQueue {
  readonly schedules = new Map<string, { cron: string; data: object; options: object }>();
  readonly queues = new Map<string, { policy?: string }>();
  readonly workers = new Map<
    string,
    (jobs: Array<{ id: string; data: unknown }>) => Promise<unknown>
  >();
  readonly sent: Array<{ name: string; data: object; options?: object }> = [];
  readonly unscheduled: string[] = [];
  readonly deleted: string[] = [];
  started = false;
  stopped = false;
  queueSizes = new Map<string, number>();

  async start(): Promise<unknown> {
    this.started = true;
    return this;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  async createQueue(name: string, options?: { policy?: string }): Promise<void> {
    this.queues.set(name, options ?? {});
  }
  async schedule(name: string, cron: string, data?: object, options?: object): Promise<void> {
    this.schedules.set(name, { cron, data: data ?? {}, options: options ?? {} });
  }
  async unschedule(name: string): Promise<void> {
    this.schedules.delete(name);
    this.unscheduled.push(name);
  }
  async getSchedules(): Promise<Array<{ name: string; cron: string }>> {
    return [...this.schedules.entries()].map(([name, value]) => ({ name, cron: value.cron }));
  }
  async deleteQueue(name: string): Promise<void> {
    this.queues.delete(name);
    this.deleted.push(name);
  }
  async send(name: string, data: object, options?: object): Promise<string | null> {
    this.sent.push({ name, data, options });
    return `job-${this.sent.length}`;
  }
  async work(
    name: string,
    _options: object,
    handler: (jobs: Array<{ id: string; data: unknown }>) => Promise<unknown>,
  ): Promise<string> {
    this.workers.set(name, handler);
    return `worker-${name}`;
  }
  async offWork(name: string): Promise<void> {
    this.workers.delete(name);
  }
  async getQueueSize(name: string): Promise<number> {
    return this.queueSizes.get(name) ?? 0;
  }

  /** Drive a queue's worker as pg-boss would. */
  async dispatch(name: string, data: unknown): Promise<void> {
    const handler = this.workers.get(name);
    if (!handler) throw new Error(`no worker registered for ${name}`);
    await handler([{ id: 'job-1', data }]);
  }
}

/** A Database double exposing just the one query the scheduler makes. */
function fakeDb(
  monitors: Array<{ id: string; enabled: boolean; paused: boolean; schedule_cron: string }>,
): Database {
  return {
    query: vi.fn(async (text: string) => {
      if (text.includes('FROM monitors')) return { rows: monitors } as never;
      return { rows: [] } as never;
    }),
    transaction: vi.fn(),
    end: vi.fn(),
    ping: vi.fn(),
    raw: vi.fn(),
  } as unknown as Database;
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function makeScheduler(queue: FakeQueue, monitors: Parameters<typeof fakeDb>[0], overrides = {}) {
  const captured: Array<{ monitorId: string; data: CaptureJobData }> = [];
  const retentionRuns: number[] = [];

  const scheduler = new Scheduler({
    db: fakeDb(monitors),
    queue,
    logger: silentLogger,
    onCapture: async (monitorId, data) => {
      captured.push({ monitorId, data });
    },
    onRetention: async () => {
      retentionRuns.push(Date.now());
    },
    pollingIntervalSeconds: 1,
    singletonSeconds: 120,
    ...overrides,
  });

  return { scheduler, captured, retentionRuns };
}

describe('captureQueueName', () => {
  it('prefixes the monitor id so queues cannot collide with other job names', () => {
    expect(captureQueueName('abc')).toBe(`${CAPTURE_QUEUE_PREFIX}abc`);
    expect(captureQueueName('abc')).not.toBe(RETENTION_QUEUE);
  });
});

describe('Scheduler.start', () => {
  it('attaches a worker to schedules that already exist after a restart', async () => {
    const queue = new FakeQueue();
    await queue.schedule(captureQueueName('m1'), '*/15 * * * *');
    const { scheduler, captured } = makeScheduler(queue, [
      { id: 'm1', enabled: true, paused: false, schedule_cron: '*/15 * * * *' },
    ]);
    await scheduler.start();
    await queue.dispatch(captureQueueName('m1'), { monitorId: 'm1', manual: false });
    expect(captured).toHaveLength(1);
    await scheduler.stop();
  });
  it('starts the queue, registers the retention job and reconciles monitors', async () => {
    const queue = new FakeQueue();
    const { scheduler } = makeScheduler(queue, [
      { id: 'm1', enabled: true, paused: false, schedule_cron: '*/15 * * * *' },
    ]);

    await scheduler.start();

    expect(queue.started).toBe(true);
    expect(queue.queues.has(RETENTION_QUEUE)).toBe(true);
    expect(queue.workers.has(RETENTION_QUEUE)).toBe(true);
    expect(queue.schedules.has(RETENTION_QUEUE)).toBe(true);

    // One queue and one schedule per enabled monitor.
    expect(queue.schedules.has(captureQueueName('m1'))).toBe(true);
    expect(queue.schedules.get(captureQueueName('m1'))?.cron).toBe('*/15 * * * *');
    expect(queue.workers.has(captureQueueName('m1'))).toBe(true);

    await scheduler.stop();
  });

  it('is idempotent', async () => {
    const queue = new FakeQueue();
    const { scheduler } = makeScheduler(queue, []);
    await scheduler.start();
    await scheduler.start();
    expect(queue.workers.size).toBe(1); // retention only
    await scheduler.stop();
  });

  it('carries a singleton key so two instances cannot run one monitor at once', async () => {
    const queue = new FakeQueue();
    const { scheduler } = makeScheduler(queue, [
      { id: 'm1', enabled: true, paused: false, schedule_cron: '0 * * * *' },
    ]);
    await scheduler.start();

    const options = queue.schedules.get(captureQueueName('m1'))?.options as {
      singletonKey?: string;
      singletonSeconds?: number;
    };
    expect(options?.singletonKey).toBe('m1');
    expect(options?.singletonSeconds).toBe(120);
    expect(queue.queues.get(captureQueueName('m1'))?.policy).toBe('singleton');

    await scheduler.stop();
  });
});

describe('Scheduler.sync', () => {
  it('creates a schedule for every enabled monitor', async () => {
    const queue = new FakeQueue();
    const { scheduler } = makeScheduler(queue, [
      { id: 'm1', enabled: true, paused: false, schedule_cron: '*/15 * * * *' },
      { id: 'm2', enabled: true, paused: false, schedule_cron: '0 6 * * *' },
    ]);

    const result = await scheduler.sync();
    expect(result).toEqual({ created: 2, updated: 0, removed: 0 });
    expect(queue.schedules.get(captureQueueName('m1'))?.cron).toBe('*/15 * * * *');
    expect(queue.schedules.get(captureQueueName('m2'))?.cron).toBe('0 6 * * *');
  });

  it('skips disabled and paused monitors', async () => {
    const queue = new FakeQueue();
    const { scheduler } = makeScheduler(queue, [
      { id: 'disabled', enabled: false, paused: false, schedule_cron: '0 * * * *' },
      { id: 'paused', enabled: true, paused: true, schedule_cron: '0 * * * *' },
    ]);

    const result = await scheduler.sync();
    expect(result.created).toBe(0);
    expect(queue.schedules.size).toBe(0);
  });

  it('updates the cron in place when a monitor schedule changes', async () => {
    const queue = new FakeQueue();
    const before = makeScheduler(queue, [
      { id: 'm1', enabled: true, paused: false, schedule_cron: '0 * * * *' },
    ]);
    await before.scheduler.sync();
    expect(queue.schedules.get(captureQueueName('m1'))?.cron).toBe('0 * * * *');

    // Same queue, new database contents: the monitor's schedule was edited.
    const after = makeScheduler(queue, [
      { id: 'm1', enabled: true, paused: false, schedule_cron: '*/30 * * * *' },
    ]);
    const result = await after.scheduler.sync();

    expect(result.updated).toBe(1);
    expect(queue.schedules.get(captureQueueName('m1'))?.cron).toBe('*/30 * * * *');
    // The worker is registered once and reused, not duplicated.
    expect(queue.workers.has(captureQueueName('m1'))).toBe(true);
  });

  it('removes the schedule when a monitor is disabled', async () => {
    const queue = new FakeQueue();
    const first = makeScheduler(queue, [
      { id: 'm1', enabled: true, paused: false, schedule_cron: '0 * * * *' },
    ]);
    await first.scheduler.sync();
    expect(queue.schedules.has(captureQueueName('m1'))).toBe(true);

    const second = makeScheduler(queue, [
      { id: 'm1', enabled: false, paused: false, schedule_cron: '0 * * * *' },
    ]);
    const result = await second.scheduler.sync();

    expect(result.removed).toBe(1);
    expect(queue.schedules.has(captureQueueName('m1'))).toBe(false);
    expect(queue.unscheduled).toContain(captureQueueName('m1'));
    expect(queue.deleted).toContain(captureQueueName('m1'));
    expect(queue.workers.has(captureQueueName('m1'))).toBe(false);
  });

  it('removes the schedule when a monitor is deleted', async () => {
    const queue = new FakeQueue();
    const first = makeScheduler(queue, [
      { id: 'm1', enabled: true, paused: false, schedule_cron: '0 * * * *' },
    ]);
    await first.scheduler.sync();

    const second = makeScheduler(queue, []);
    const result = await second.scheduler.sync();
    expect(result.removed).toBe(1);
    expect(queue.schedules.size).toBe(0);
  });

  it('does not touch unrelated schedules that are not capture queues', async () => {
    const queue = new FakeQueue();
    await queue.schedule('some-other-app-job', '0 0 * * *');

    const { scheduler } = makeScheduler(queue, [
      { id: 'm1', enabled: true, paused: false, schedule_cron: '0 * * * *' },
    ]);
    await scheduler.sync();

    expect(queue.schedules.has('some-other-app-job')).toBe(true);
    expect(queue.unscheduled).not.toContain('some-other-app-job');
  });

  it('reports no work when nothing changed', async () => {
    const queue = new FakeQueue();
    const monitors = [{ id: 'm1', enabled: true, paused: false, schedule_cron: '0 * * * *' }];
    const first = makeScheduler(queue, monitors);
    await first.scheduler.sync();

    const second = makeScheduler(queue, monitors);
    expect(await second.scheduler.sync()).toEqual({ created: 0, updated: 0, removed: 0 });
  });

  it('survives a queue that cannot report its schedules', async () => {
    const queue = new FakeQueue();
    queue.getSchedules = async () => {
      throw new Error('connection lost');
    };
    const { scheduler } = makeScheduler(queue, [
      { id: 'm1', enabled: true, paused: false, schedule_cron: '0 * * * *' },
    ]);
    await expect(scheduler.sync()).resolves.toMatchObject({ created: 1 });
  });
});

describe('Scheduler job dispatch', () => {
  it('runs the capture handler with the monitor id from the queue name', async () => {
    const queue = new FakeQueue();
    const { scheduler, captured } = makeScheduler(queue, [
      { id: 'm1', enabled: true, paused: false, schedule_cron: '0 * * * *' },
    ]);
    await scheduler.sync();

    await queue.dispatch(captureQueueName('m1'), { monitorId: 'm1', manual: false });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.monitorId).toBe('m1');
    expect(captured[0]?.data.manual).toBe(false);
  });

  it('does not let one failing capture break the worker', async () => {
    const queue = new FakeQueue();
    const scheduler = new Scheduler({
      db: fakeDb([{ id: 'm1', enabled: true, paused: false, schedule_cron: '0 * * * *' }]),
      queue,
      logger: silentLogger,
      onCapture: async () => {
        throw new Error('capture exploded');
      },
      onRetention: async () => undefined,
    });
    await scheduler.sync();

    await expect(
      queue.dispatch(captureQueueName('m1'), { monitorId: 'm1', manual: false }),
    ).resolves.toBeUndefined();
  });

  it('runs retention when its queue fires, and logs rather than throws on failure', async () => {
    const queue = new FakeQueue();
    const { scheduler, retentionRuns } = makeScheduler(queue, []);
    await scheduler.start();

    await queue.dispatch(RETENTION_QUEUE, {});
    expect(retentionRuns).toHaveLength(1);

    // A failing retention run must not take the worker down.
    const failing = new Scheduler({
      db: fakeDb([]),
      queue,
      logger: silentLogger,
      onCapture: async () => undefined,
      onRetention: async () => {
        throw new Error('retention exploded');
      },
    });
    // start() resolves void; what matters is that the failing run does not throw.
    await failing.start();
    await queue.dispatch(RETENTION_QUEUE, {});
  });
});

describe('Scheduler.enqueueCapture', () => {
  it('sends a manual job with the monitor singleton key and no time window', async () => {
    const queue = new FakeQueue();
    const { scheduler } = makeScheduler(queue, [
      { id: 'm1', enabled: true, paused: false, schedule_cron: '0 * * * *' },
    ]);
    await scheduler.sync();

    const jobId = await scheduler.enqueueCapture('m1', true);

    expect(jobId).toBe('job-1');
    const sent = queue.sent[0]!;
    expect(sent.name).toBe(captureQueueName('m1'));
    expect((sent.data as CaptureJobData).manual).toBe(true);
    expect(sent.options).not.toHaveProperty('singletonSeconds');
    expect((sent.data as CaptureJobData).monitorId).toBe('m1');
    expect((sent.options as { singletonKey?: string; priority?: number }).singletonKey).toBe('m1');
    expect((sent.options as { priority?: number }).priority).toBe(10);
  });

  it('works for a paused monitor, because a manual capture is always allowed', async () => {
    const queue = new FakeQueue();
    const { scheduler } = makeScheduler(queue, [
      { id: 'm1', enabled: true, paused: true, schedule_cron: '0 * * * *' },
    ]);
    await scheduler.sync();

    // No schedule exists for a paused monitor...
    expect(queue.schedules.has(captureQueueName('m1'))).toBe(false);

    const jobId = await scheduler.enqueueCapture('m1');
    expect(jobId).not.toBeNull();
    // ...but a worker was created on demand so the job can actually run.
    expect(queue.workers.has(captureQueueName('m1'))).toBe(true);
    await queue.dispatch(captureQueueName('m1'), { monitorId: 'm1', manual: true });
  });

  it('does not leave a placeholder schedule behind for an unscheduled monitor', async () => {
    const queue = new FakeQueue();
    const { scheduler } = makeScheduler(queue, [
      { id: 'm1', enabled: false, paused: false, schedule_cron: '0 * * * *' },
    ]);
    await scheduler.sync();
    await scheduler.enqueueCapture('m1');

    expect(queue.schedules.has(captureQueueName('m1'))).toBe(false);
    expect(queue.unscheduled).toContain(captureQueueName('m1'));
  });
});

describe('Scheduler.queueDepth', () => {
  it('sums the capture queues plus retention', async () => {
    const queue = new FakeQueue();
    const { scheduler } = makeScheduler(queue, [
      { id: 'm1', enabled: true, paused: false, schedule_cron: '0 * * * *' },
      { id: 'm2', enabled: true, paused: false, schedule_cron: '0 * * * *' },
    ]);
    await scheduler.sync();

    queue.queueSizes.set(captureQueueName('m1'), 2);
    queue.queueSizes.set(captureQueueName('m2'), 3);
    queue.queueSizes.set(RETENTION_QUEUE, 1);

    expect(await scheduler.queueDepth()).toBe(6);
  });

  it('returns zero rather than throwing when the queue is unavailable', async () => {
    const queue = new FakeQueue();
    queue.getSchedules = async () => {
      throw new Error('down');
    };
    const { scheduler } = makeScheduler(queue, []);
    expect(await scheduler.queueDepth()).toBe(0);
  });
});

describe('Scheduler.stop', () => {
  it('stops the queue and refuses to register anything afterwards', async () => {
    const queue = new FakeQueue();
    const { scheduler } = makeScheduler(queue, []);
    await scheduler.start();
    await scheduler.stop({ timeoutMs: 100 });

    expect(queue.stopped).toBe(true);
    await scheduler.sync();
    expect(queue.workers.size).toBe(1); // retention only, nothing new
  });
});

describe('MetricsRegistry', () => {
  it('renders counters with labels', () => {
    const metrics = new MetricsRegistry();
    metrics.capturesTotal.inc({ status: 'success' });
    metrics.capturesTotal.inc({ status: 'success' });
    metrics.capturesTotal.inc({ status: 'failed' });

    const { body, contentType } = metrics.expose();
    expect(contentType).toContain('text/plain');
    expect(body).toContain('# TYPE pagefreeze_captures_total counter');
    expect(body).toContain('pagefreeze_captures_total{status="success"} 2');
    expect(body).toContain('pagefreeze_captures_total{status="failed"} 1');
  });

  it('renders gauges, overwriting the previous value', () => {
    const metrics = new MetricsRegistry();
    metrics.queueDepth.set(5, { queue: 'capture' });
    metrics.queueDepth.set(2, { queue: 'capture' });
    metrics.queueDepth.set(1, { queue: 'retention' });

    const body = metrics.expose().body;
    expect(body).toContain('# TYPE pagefreeze_queue_depth gauge');
    expect(body).toContain('pagefreeze_queue_depth{queue="capture"} 2');
    expect(body).toContain('pagefreeze_queue_depth{queue="retention"} 1');
    expect(body).not.toContain('pagefreeze_queue_depth{queue="capture"} 5');
  });

  it('renders histograms with cumulative buckets, a sum and a count', () => {
    const metrics = new MetricsRegistry();
    metrics.captureDuration.observe(0.5, { status: 'success' });
    metrics.captureDuration.observe(3, { status: 'success' });
    metrics.captureDuration.observe(90, { status: 'failed' });

    const body = metrics.expose().body;
    expect(body).toContain('# TYPE pagefreeze_capture_duration_seconds histogram');
    // Buckets are cumulative: both 0.5s and 3s fall in the <=5 bucket.
    expect(body).toContain('pagefreeze_capture_duration_seconds_bucket{status="success",le="5"} 2');
    expect(body).toContain(
      'pagefreeze_capture_duration_seconds_bucket{status="success",le="+Inf"} 2',
    );
    expect(body).toContain('pagefreeze_capture_duration_seconds_sum{status="success"} 3.5');
    expect(body).toContain('pagefreeze_capture_duration_seconds_count{status="success"} 2');
    expect(body).toContain('pagefreeze_capture_duration_seconds_count{status="failed"} 1');
  });

  it('renders a gauge with no labels', () => {
    const metrics = new MetricsRegistry();
    metrics.storageBytes.set(1234);
    expect(metrics.expose().body).toContain('pagefreeze_storage_bytes 1234');
  });

  it('escapes label values', () => {
    const metrics = new MetricsRegistry();
    metrics.monitorsTotal.set(1, { state: 'a"b\\c' });
    expect(metrics.expose().body).toContain('pagefreeze_monitors_total{state="a\\"b\\\\c"} 1');
  });

  it('emits every registered metric family even when empty', () => {
    const body = new MetricsRegistry().expose().body;
    for (const name of [
      'pagefreeze_captures_total',
      'pagefreeze_capture_duration_seconds',
      'pagefreeze_changes_total',
      'pagefreeze_notifications_total',
      'pagefreeze_queue_depth',
      'pagefreeze_captures_in_flight',
      'pagefreeze_monitors_total',
      'pagefreeze_snapshots_total',
      'pagefreeze_storage_bytes',
      'pagefreeze_process_uptime_seconds',
    ]) {
      expect(body, name).toContain(`# HELP ${name}`);
    }
  });
});
