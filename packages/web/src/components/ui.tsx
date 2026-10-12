import { useEffect, useState, type ReactNode } from 'react';
import type { MonitorStatus } from '@pagefreeze/shared';
import { ApiError } from '../api/client.js';
import { IconAlert, IconCheck, IconCopy, IconInbox } from './Icons.js';

/* ------------------------------------------------------------------ feedback */

export function Spinner({ large = false, label = 'Loading' }: { large?: boolean; label?: string }) {
  return (
    <span className={large ? 'spinner spinner--lg' : 'spinner'} role="status" aria-label={label} />
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <Spinner large label={label} />
      <div className="state__body">{label}</div>
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="state">
      <IconInbox size={34} className="state__icon" />
      <div className="state__title">{title}</div>
      {body ? <div className="state__body">{body}</div> : null}
      {action}
    </div>
  );
}

/** Human text for an API error, including the field-level details from zod. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const details = error.details as Array<{ path: string; message: string }> | undefined;
    if (Array.isArray(details) && details.length > 0) {
      return `${error.message}: ${details.map((d) => `${d.path} — ${d.message}`).join('; ')}`;
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function ErrorState({
  error,
  onRetry,
  title = 'Something went wrong',
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <div className="state">
      <IconAlert size={34} className="state__icon" />
      <div className="state__title">{title}</div>
      <div className="state__body">
        <div className="alert alert--error" role="alert">
          <div className="alert__body">{describeError(error)}</div>
        </div>
      </div>
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function Alert({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'error' | 'warn';
  children: ReactNode;
}) {
  return (
    <div className={`alert alert--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div className="alert__body">{children}</div>
    </div>
  );
}

/* -------------------------------------------------------------------- status */

const STATUS_LABEL: Record<MonitorStatus, string> = {
  ok: 'OK',
  changed: 'Changed',
  failing: 'Failing',
  paused: 'Paused',
};

export function StatusBadge({ status, label }: { status: MonitorStatus; label?: string }) {
  return (
    <span className={`badge badge--${status}`}>
      <span className="badge__dot" aria-hidden="true" />
      {label ?? STATUS_LABEL[status]}
    </span>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="tag">{children}</span>;
}

/* ----------------------------------------------------------------- sparkline */

/**
 * Change-count sparkline. Bars are marked up as a list with an accessible summary rather
 * than an inline SVG, so the trend is available to screen readers too.
 */
export function Sparkline({ values, title }: { values: number[]; title?: string }) {
  const max = Math.max(1, ...values);
  const total = values.reduce((sum, value) => sum + value, 0);
  const label = title ?? `${total} change${total === 1 ? '' : 's'} in the last 14 days`;

  return (
    <span className="sparkline" role="img" aria-label={label} title={label}>
      {values.map((value, index) => (
        <span
          key={index}
          className={value > 0 ? 'sparkline__bar sparkline__bar--active' : 'sparkline__bar'}
          style={{ height: `${Math.max(2, Math.round((value / max) * 22))}px` }}
        />
      ))}
    </span>
  );
}

/* -------------------------------------------------------------------- copy */

export function CopyButton({
  value,
  label = 'Copy',
  copiedLabel = 'Copied',
  className = 'btn btn--sm',
}: {
  value: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard access is denied in some contexts; fall back to a selectable prompt.
      const field = document.createElement('textarea');
      field.value = value;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      try {
        document.execCommand('copy');
        setCopied(true);
      } catch {
        setCopied(false);
      }
      document.body.removeChild(field);
    }
  };

  return (
    <button type="button" className={className} onClick={() => void onCopy()} aria-live="polite">
      {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
      {copied ? copiedLabel : label}
    </button>
  );
}

/* ------------------------------------------------------------------- time */

/**
 * Relative time with an absolute title. Rendered from the viewer's locale, while all
 * stored timestamps are UTC.
 */
export function TimeAgo({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="faint">never</span>;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span className="faint">{value}</span>;

  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  const absolute = date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  let text: string;
  if (seconds < 45) text = 'just now';
  else if (seconds < 90) text = 'a minute ago';
  else if (seconds < 3600) text = `${Math.round(seconds / 60)} minutes ago`;
  else if (seconds < 5400) text = 'an hour ago';
  else if (seconds < 86400) text = `${Math.round(seconds / 3600)} hours ago`;
  else if (seconds < 172800) text = 'yesterday';
  else if (seconds < 2592000) text = `${Math.round(seconds / 86400)} days ago`;
  else text = date.toLocaleDateString(undefined, { dateStyle: 'medium' });

  return (
    <time dateTime={date.toISOString()} title={absolute}>
      {text}
    </time>
  );
}

export function AbsoluteTime({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="faint">—</span>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span className="faint">{value}</span>;
  return (
    <time dateTime={date.toISOString()} title={date.toISOString()}>
      {date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })}
    </time>
  );
}

/* --------------------------------------------------------------- pagination */

/**
 * Cursor pagination keeps a stack of previously seen cursors so "previous" works without
 * the server supporting reverse traversal.
 */
export function useCursorStack() {
  const [stack, setStack] = useState<Array<string | undefined>>([undefined]);
  const cursor = stack[stack.length - 1];

  return {
    cursor,
    page: stack.length,
    next(nextCursor: string | null): void {
      if (!nextCursor) return;
      setStack((current) => [...current, nextCursor]);
    },
    previous(): void {
      setStack((current) => (current.length > 1 ? current.slice(0, -1) : current));
    },
    reset(): void {
      setStack([undefined]);
    },
    canPrevious: stack.length > 1,
  };
}

export function Pager({
  hasMore,
  canPrevious,
  onNext,
  onPrevious,
  loading,
}: {
  hasMore: boolean;
  canPrevious: boolean;
  onNext: () => void;
  onPrevious: () => void;
  loading?: boolean;
}) {
  if (!hasMore && !canPrevious) return null;
  return (
    <div className="pager">
      <button
        type="button"
        className="btn btn--sm"
        onClick={onPrevious}
        disabled={!canPrevious || loading}
      >
        Previous
      </button>
      <button type="button" className="btn btn--sm" onClick={onNext} disabled={!hasMore || loading}>
        {loading ? 'Loading…' : 'Next'}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------- misc */

export function bytesLabel(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function percentLabel(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return '—';
  return `${value.toFixed(digits)}%`;
}

export function durationLabel(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
