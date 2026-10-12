import { randomUUID } from 'node:crypto';
import type { SsrfGuard } from '../capture/ssrf.js';
import { buildSignedHeaders, SIGNATURE_HEADER } from './signing.js';
import { renderEventText, type NotificationEvent } from './events.js';

/**
 * Channel configuration as stored (decrypted).
 *
 * `secret` is the webhook HMAC key. It is only ever present inside this object, in
 * memory, for the duration of a delivery; it is never logged and never returned by the
 * API.
 */
export interface ResolvedChannelConfig {
  type: 'webhook' | 'slack' | 'email';
  url?: string;
  secret?: string | null;
  to?: string[];
  subject?: string;
}

export interface DeliveryResult {
  ok: boolean;
  status?: number;
  error?: string;
  durationMs: number;
}

/** Injectable HTTP client so tests never touch the network. */
export interface HttpClient {
  post(options: {
    url: string;
    headers: Record<string, string>;
    body: string;
    timeoutMs: number;
    redirect: 'error' | 'follow' | 'manual';
    maxRedirects?: number;
  }): Promise<{ status: number; body: string }>;
}

/** Injectable mailer so tests never touch SMTP. */
export interface Mailer {
  send(options: { to: string[]; subject: string; text: string }): Promise<void>;
}

export interface NotifierOptions {
  guard: SsrfGuard;
  http: HttpClient;
  mailer: Mailer | null;
  userAgent: string;
  timeoutMs: number;
  maxRedirects: number;
  logger?: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    debug: (obj: unknown, msg?: string) => void;
  };
}

/**
 * Notifier is the seam the rest of the app depends on. Everything that wants to tell a
 * human about a change goes through `deliver()`.
 */
export interface Notifier {
  deliver(
    channel: { id: string; name: string },
    config: ResolvedChannelConfig,
    event: NotificationEvent,
  ): Promise<DeliveryResult>;
}

/** Build the Slack "incoming webhook" body: `{ text }` plus a Block Kit attachment. */
export function buildSlackPayload(event: NotificationEvent): string {
  const text = renderEventText(event);

  const color =
    event.type === 'capture.failed'
      ? '#d1495b'
      : event.type === 'change.detected'
        ? '#e0a458'
        : '#6a994e';

  const fields: Array<{ title: string; value: string; short: boolean }> = [];

  if (event.monitor) {
    fields.push({ title: 'Monitor', value: event.monitor.name, short: true });
    fields.push({ title: 'URL', value: event.monitor.url, short: false });
  }
  if (event.change) {
    if (event.change.pixelDiffPercent !== null) {
      fields.push({
        title: 'Pixel diff',
        value: `${event.change.pixelDiffPercent.toFixed(2)}%`,
        short: true,
      });
    }
    fields.push({
      title: 'Significant',
      value: event.change.significant ? 'yes' : 'no',
      short: true,
    });
  }
  if (event.failure) {
    fields.push({
      title: 'Consecutive failures',
      value: String(event.failure.consecutiveFailures),
      short: true,
    });
  }

  return JSON.stringify({
    text,
    attachments: [
      {
        color,
        title: text.split('\n')[0],
        fields,
        ...(event.links.change ? { title_link: event.links.change } : {}),
        footer: 'Pagefreeze',
        ts: Math.floor(new Date(event.occurredAt).getTime() / 1000),
      },
    ],
  });
}

/** Generic JSON webhook body: the event itself plus a schema version. */
export function buildWebhookPayload(event: NotificationEvent): string {
  return JSON.stringify({ schema: 'pagefreeze/v1', event });
}

export class NotificationService implements Notifier {
  constructor(private readonly options: NotifierOptions) {}

  async deliver(
    channel: { id: string; name: string },
    config: ResolvedChannelConfig,
    event: NotificationEvent,
  ): Promise<DeliveryResult> {
    const started = Date.now();

    try {
      switch (config.type) {
        case 'email':
          return await this.deliverEmail(config, event, started);
        case 'slack':
          return await this.deliverHttp(channel, config, event, started, 'slack');
        case 'webhook':
        default:
          return await this.deliverHttp(channel, config, event, started, 'webhook');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger?.warn(
        { channelId: channel.id, type: config.type, error: message },
        'notification delivery failed',
      );
      return { ok: false, error: message, durationMs: Date.now() - started };
    }
  }

  private async deliverEmail(
    config: ResolvedChannelConfig,
    event: NotificationEvent,
    started: number,
  ): Promise<DeliveryResult> {
    if (!this.options.mailer) {
      return {
        ok: false,
        error: 'SMTP is not configured (set SMTP_HOST to enable email notifications)',
        durationMs: Date.now() - started,
      };
    }
    const to = config.to ?? [];
    if (to.length === 0) {
      return { ok: false, error: 'channel has no recipients', durationMs: Date.now() - started };
    }

    const subject =
      config.subject ??
      `[Pagefreeze] ${event.monitor?.name ?? 'notification'}: ${
        event.type === 'change.detected'
          ? 'page changed'
          : event.type === 'capture.failed'
            ? 'capture failing'
            : event.type === 'capture.recovered'
              ? 'capture recovered'
              : 'test'
      }`;

    await this.options.mailer.send({ to, subject, text: renderEventText(event) });
    return { ok: true, durationMs: Date.now() - started };
  }

  private async deliverHttp(
    channel: { id: string; name: string },
    config: ResolvedChannelConfig,
    event: NotificationEvent,
    started: number,
    kind: 'webhook' | 'slack',
  ): Promise<DeliveryResult> {
    const url = config.url;
    if (!url) {
      return { ok: false, error: 'channel has no url', durationMs: Date.now() - started };
    }

    // Outbound webhooks go through the same SSRF guard as captures: a channel URL is
    // operator-controlled input that would otherwise be a convenient way to reach the
    // metadata service.
    const verdict = await this.options.guard.checkUrl(url);
    if (!verdict.allowed) {
      return {
        ok: false,
        error: `destination blocked by SSRF guard: ${verdict.reason}`,
        durationMs: Date.now() - started,
      };
    }

    const body = kind === 'slack' ? buildSlackPayload(event) : buildWebhookPayload(event);
    const deliveryId = randomUUID();

    // Slack-compatible endpoints do not verify our signature, but signing them is
    // harmless and keeps one code path.
    const headers = buildSignedHeaders({
      secret: config.secret ?? null,
      timestamp: Math.floor(Date.now() / 1000),
      body,
      deliveryId,
      event: event.type,
      userAgent: this.options.userAgent,
    });

    this.options.logger?.debug(
      {
        channelId: channel.id,
        type: kind,
        event: event.type,
        signature: headers[SIGNATURE_HEADER] ? 'present' : 'absent',
      },
      'delivering notification',
    );

    const response = await this.options.http.post({
      url,
      headers: headers as unknown as Record<string, string>,
      body,
      timeoutMs: this.options.timeoutMs,
      redirect: this.options.maxRedirects > 0 ? 'follow' : 'error',
      maxRedirects: this.options.maxRedirects,
    });

    const ok = response.status >= 200 && response.status < 300;
    return {
      ok,
      status: response.status,
      ...(ok ? {} : { error: `unexpected status ${response.status}` }),
      durationMs: Date.now() - started,
    };
  }
}

/** A Notifier that records deliveries instead of performing them. Used by tests. */
export class RecordingNotifier implements Notifier {
  readonly deliveries: Array<{
    channelId: string;
    config: ResolvedChannelConfig;
    event: NotificationEvent;
  }> = [];

  constructor(private readonly result: DeliveryResult = { ok: true, durationMs: 1 }) {}

  async deliver(
    channel: { id: string; name: string },
    config: ResolvedChannelConfig,
    event: NotificationEvent,
  ): Promise<DeliveryResult> {
    this.deliveries.push({ channelId: channel.id, config, event });
    return this.result;
  }
}
