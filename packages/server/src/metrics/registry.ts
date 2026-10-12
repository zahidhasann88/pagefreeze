/**
 * Prometheus metrics.
 *
 * Hand-rolled rather than pulled from `prom-client`: the exposition format for counters,
 * gauges and histograms is small, and keeping it in-house avoids a dependency whose API
 * surface we barely use.
 */

export interface MetricSample {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  labels: string[];
}

const BUCKETS = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

type LabelValues = Record<string, string>;

function labelKey(labels: LabelValues, order: string[]): string {
  return order.map((name) => labels[name] ?? '').join('\u0000');
}

function formatLabels(labels: LabelValues, order: string[]): string {
  if (order.length === 0) return '';
  const parts = order.map((name) => {
    const value = String(labels[name] ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');
    return `${name}="${value}"`;
  });
  return `{${parts.join(',')}}`;
}

class Counter {
  private readonly values = new Map<string, number>();
  private readonly seen = new Map<string, LabelValues>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: string[],
  ) {}

  inc(labels: LabelValues = {}, amount = 1): void {
    const key = labelKey(labels, this.labelNames);
    this.seen.set(key, labels);
    this.values.set(key, (this.values.get(key) ?? 0) + amount);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.values) {
      lines.push(`${this.name}${formatLabels(this.seen.get(key) ?? {}, this.labelNames)} ${value}`);
    }
    return lines.join('\n');
  }
}

class Gauge {
  private readonly values = new Map<string, number>();
  private readonly seen = new Map<string, LabelValues>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: string[],
  ) {}

  set(value: number, labels: LabelValues = {}): void {
    const key = labelKey(labels, this.labelNames);
    this.seen.set(key, labels);
    this.values.set(key, value);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [key, value] of this.values) {
      lines.push(`${this.name}${formatLabels(this.seen.get(key) ?? {}, this.labelNames)} ${value}`);
    }
    return lines.join('\n');
  }
}

class Histogram {
  private readonly counts = new Map<string, number[]>();
  private readonly sums = new Map<string, number>();
  private readonly totals = new Map<string, number>();
  private readonly seen = new Map<string, LabelValues>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: string[],
    readonly buckets: number[] = BUCKETS,
  ) {}

  observe(value: number, labels: LabelValues = {}): void {
    const key = labelKey(labels, this.labelNames);
    this.seen.set(key, labels);

    let counts = this.counts.get(key);
    if (!counts) {
      counts = new Array<number>(this.buckets.length).fill(0);
      this.counts.set(key, counts);
      this.sums.set(key, 0);
      this.totals.set(key, 0);
    }

    for (let i = 0; i < this.buckets.length; i += 1) {
      if (value <= this.buckets[i]!) counts[i] = (counts[i] ?? 0) + 1;
    }
    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
    this.totals.set(key, (this.totals.get(key) ?? 0) + 1);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, counts] of this.counts) {
      const labels = this.seen.get(key) ?? {};
      this.buckets.forEach((bucket, index) => {
        const withLe = { ...labels, le: String(bucket) };
        lines.push(
          `${this.name}_bucket${formatLabels(withLe, [...this.labelNames, 'le'])} ${counts[index] ?? 0}`,
        );
      });
      lines.push(
        `${this.name}_bucket${formatLabels({ ...labels, le: '+Inf' }, [...this.labelNames, 'le'])} ${this.totals.get(key) ?? 0}`,
      );
      lines.push(
        `${this.name}_sum${formatLabels(labels, this.labelNames)} ${this.sums.get(key) ?? 0}`,
      );
      lines.push(
        `${this.name}_count${formatLabels(labels, this.labelNames)} ${this.totals.get(key) ?? 0}`,
      );
    }
    return lines.join('\n');
  }
}

export class MetricsRegistry {
  readonly capturesTotal = new Counter(
    'pagefreeze_captures_total',
    'Number of captures performed, by outcome.',
    ['status'],
  );
  readonly captureDuration = new Histogram(
    'pagefreeze_capture_duration_seconds',
    'Capture duration in seconds, including retries.',
    ['status'],
  );
  readonly changesTotal = new Counter(
    'pagefreeze_changes_total',
    'Number of changes recorded, by significance.',
    ['significant'],
  );
  readonly notificationsTotal = new Counter(
    'pagefreeze_notifications_total',
    'Number of notification deliveries attempted, by outcome.',
    ['status'],
  );
  readonly queueDepth = new Gauge(
    'pagefreeze_queue_depth',
    'Number of jobs waiting in the capture queue.',
    ['queue'],
  );
  readonly capturesInFlight = new Gauge(
    'pagefreeze_captures_in_flight',
    'Number of captures currently running.',
    [],
  );
  readonly monitorsTotal = new Gauge('pagefreeze_monitors_total', 'Number of monitors, by state.', [
    'state',
  ]);
  readonly snapshotsTotal = new Gauge(
    'pagefreeze_snapshots_total',
    'Number of snapshots stored.',
    [],
  );
  readonly storageBytes = new Gauge(
    'pagefreeze_storage_bytes',
    'Bytes of snapshot artefacts on disk.',
    [],
  );
  readonly processUptime = new Gauge(
    'pagefreeze_process_uptime_seconds',
    'Seconds since the process started.',
    [],
  );

  render(): string {
    return [
      this.capturesTotal,
      this.captureDuration,
      this.changesTotal,
      this.notificationsTotal,
      this.queueDepth,
      this.capturesInFlight,
      this.monitorsTotal,
      this.snapshotsTotal,
      this.storageBytes,
      this.processUptime,
    ]
      .map((metric) => metric.render())
      .join('\n');
  }

  /** Text for the /metrics endpoint, with the Prometheus content type. */
  expose(): { body: string; contentType: string } {
    return { body: `${this.render()}\n`, contentType: 'text/plain; version=0.0.4; charset=utf-8' };
  }
}

export const globalRegistry = new MetricsRegistry();
