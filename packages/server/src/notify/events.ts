import type { Change, Monitor } from '@pagefreeze/shared';

export type NotificationEventType =
  'change.detected' | 'capture.failed' | 'capture.recovered' | 'channel.test';
export interface ChangeNotificationPayload {
  changeId: string;
  pixelDiffPercent: number | null;
  sizeChanged: boolean;
  significant: boolean;
  summary: string;
  textAdded: number | null;
  textRemoved: number | null;
  htmlAdded: number | null;
  htmlRemoved: number | null;
  createdAt: string;
}
export interface FailureNotificationPayload {
  consecutiveFailures: number;
  error: string | null;
  occurredAt: string;
}
export interface NotificationEvent {
  type: NotificationEventType;
  occurredAt: string;
  monitor: {
    id: string;
    name: string;
    url: string;
    tags: string[];
  } | null;
  change: ChangeNotificationPayload | null;
  failure: FailureNotificationPayload | null;
  message: string | null;
  links: {
    change: string | null;
    share: string | null;
  };
}

export function buildChangeEvent(
  monitor: Monitor,
  change: Change,
  links: { change: string | null; share: string | null },
  occurredAt: Date,
): NotificationEvent {
  return {
    type: 'change.detected',
    occurredAt: occurredAt.toISOString(),
    monitor: {
      id: monitor.id,
      name: monitor.name,
      url: monitor.url,
      tags: monitor.tags,
    },
    change: {
      changeId: change.id,
      pixelDiffPercent: change.pixelDiffPercent,
      sizeChanged: change.sizeChanged,
      significant: change.significant,
      summary: change.summary,
      textAdded: change.textAdded,
      textRemoved: change.textRemoved,
      htmlAdded: change.htmlAdded,
      htmlRemoved: change.htmlRemoved,
      createdAt: change.createdAt,
    },
    failure: null,
    message: change.summary,
    links,
  };
}

export function buildFailureEvent(
  monitor: Monitor,
  consecutiveFailures: number,
  error: string | null,
  occurredAt: Date,
): NotificationEvent {
  return {
    type: 'capture.failed',
    occurredAt: occurredAt.toISOString(),
    monitor: {
      id: monitor.id,
      name: monitor.name,
      url: monitor.url,
      tags: monitor.tags,
    },
    change: null,
    failure: {
      consecutiveFailures,
      error,
      occurredAt: occurredAt.toISOString(),
    },
    message: `Capture failed ${consecutiveFailures} time(s) in a row: ${error ?? 'unknown error'}`,
    links: { change: null, share: null },
  };
}

export function buildRecoveryEvent(
  monitor: Monitor,
  previousFailures: number,
  occurredAt: Date,
): NotificationEvent {
  return {
    type: 'capture.recovered',
    occurredAt: occurredAt.toISOString(),
    monitor: {
      id: monitor.id,
      name: monitor.name,
      url: monitor.url,
      tags: monitor.tags,
    },
    change: null,
    failure: {
      consecutiveFailures: 0,
      error: null,
      occurredAt: occurredAt.toISOString(),
    },
    message: `Capture recovered after ${previousFailures} consecutive failure(s)`,
    links: { change: null, share: null },
  };
}

export function buildTestEvent(message: string | null, occurredAt: Date): NotificationEvent {
  return {
    type: 'channel.test',
    occurredAt: occurredAt.toISOString(),
    monitor: null,
    change: null,
    failure: null,
    message: message ?? 'Test notification from Pagefreeze',
    links: { change: null, share: null },
  };
}

export function renderEventText(event: NotificationEvent): string {
  const lines: string[] = [];
  const title =
    event.type === 'change.detected'
      ? 'Page changed'
      : event.type === 'capture.failed'
        ? 'Capture failing'
        : event.type === 'capture.recovered'
          ? 'Capture recovered'
          : 'Test notification';

  lines.push(`${title}: ${event.monitor?.name ?? 'Pagefreeze'}`);
  if (event.monitor) lines.push(`URL: ${event.monitor.url}`);
  if (event.message) lines.push(event.message);

  if (event.change) {
    if (event.change.pixelDiffPercent !== null) {
      lines.push(`Pixel diff: ${event.change.pixelDiffPercent.toFixed(2)}%`);
    }
    if (event.change.textAdded !== null || event.change.textRemoved !== null) {
      lines.push(`Text: +${event.change.textAdded ?? 0} / -${event.change.textRemoved ?? 0} lines`);
    }
    if (event.change.htmlAdded !== null || event.change.htmlRemoved !== null) {
      lines.push(`HTML: +${event.change.htmlAdded ?? 0} / -${event.change.htmlRemoved ?? 0} lines`);
    }
  }

  if (event.links.change) lines.push(`Details: ${event.links.change}`);
  if (event.links.share) lines.push(`Share link: ${event.links.share}`);

  return lines.join('\n');
}
