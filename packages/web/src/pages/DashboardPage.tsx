import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MonitorStatus, MonitorSummary } from '@pagefreeze/shared';
import { useMonitors, useCaptureNow, type MonitorListParams } from '../api/hooks.js';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Pager,
  Sparkline,
  StatusBadge,
  Tag,
  TimeAgo,
  useCursorStack,
} from '../components/ui.js';
import { IconCamera, IconPlus, IconSearch } from '../components/Icons.js';

const STATUS_FILTERS: Array<{ value: MonitorListParams['status']; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'ok', label: 'OK' },
  { value: 'changed', label: 'Changed' },
  { value: 'failing', label: 'Failing' },
  { value: 'paused', label: 'Paused' },
];

/**
 * Debounced search text.
 *
 * The list endpoint filters server-side, so typing straight into the query would issue a
 * request per keystroke against a table that can hold thousands of monitors.
 */
function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function DashboardPage() {
  const [status, setStatus] = useState<MonitorStatus | 'all'>('all');
  const [tag, setTag] = useState('');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search.trim(), 300);

  const paging = useCursorStack();

  const params: MonitorListParams = {
    status,
    limit: 24,
    ...(tag ? { tag } : {}),
    ...(debouncedSearch ? { q: debouncedSearch } : {}),
    ...(paging.cursor ? { cursor: paging.cursor } : {}),
  };

  const query = useMonitors(params);
  const monitors = query.data?.data ?? [];

  // Every tag currently in use, so the filter offers real choices rather than a free-text
  // guess. Derived from the loaded page only: it is a convenience, not an index.
  const availableTags = useMemo(() => {
    const set = new Set<string>();
    for (const monitor of monitors) for (const item of monitor.tags) set.add(item);
    return [...set].sort();
  }, [monitors]);

  const isFiltering = Boolean(tag || debouncedSearch) || status !== 'all';

  return (
    <div className="stack">
      <div className="page-head">
        <div className="page-head__title">
          <h1>Dashboard</h1>
          <div className="page-head__subtitle">
            Scheduled snapshots of the pages you watch, newest changes first.
          </div>
        </div>
        <div className="page-head__actions">
          <Link to="/monitors/new" className="btn btn--primary">
            <IconPlus size={14} />
            New monitor
          </Link>
        </div>
      </div>

      <div className="filters" role="search">
        <div className="filters__search" style={{ position: 'relative' }}>
          <label className="sr-only" htmlFor="monitor-search">
            Search monitors by name or URL
          </label>
          <input
            id="monitor-search"
            className="input"
            type="search"
            placeholder="Search by name or URL…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <div className="field">
          <label className="sr-only" htmlFor="status-filter">
            Filter by status
          </label>
          <select
            id="status-filter"
            className="select"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as MonitorStatus | 'all');
              paging.reset();
            }}
          >
            {STATUS_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="sr-only" htmlFor="tag-filter">
            Filter by tag
          </label>
          <select
            id="tag-filter"
            className="select"
            value={tag}
            onChange={(event) => {
              setTag(event.target.value);
              paging.reset();
            }}
          >
            <option value="">All tags</option>
            {availableTags.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
            {/* Keep a chosen tag selectable even if it is not on this page. */}
            {tag && !availableTags.includes(tag) ? <option value={tag}>{tag}</option> : null}
          </select>
        </div>

        {isFiltering ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setStatus('all');
              setTag('');
              setSearch('');
              paging.reset();
            }}
          >
            Clear filters
          </button>
        ) : null}

        <IconSearch size={15} className="faint" aria-hidden="true" />
      </div>

      {query.isLoading ? <LoadingState label="Loading monitors…" /> : null}
      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : null}

      {!query.isLoading && !query.isError && monitors.length === 0 ? (
        <div className="card">
          <EmptyState
            title={isFiltering ? 'No monitors match those filters' : 'No monitors yet'}
            body={
              isFiltering ? (
                'Try clearing the search or choosing a different status.'
              ) : (
                <>
                  Add a URL you care about — a competitor's pricing page, your terms of service, a
                  docs page — and Pagefreeze will snapshot it on a schedule and show you exactly
                  what changed.
                </>
              )
            }
            action={
              isFiltering ? undefined : (
                <Link to="/monitors/new" className="btn btn--primary">
                  <IconPlus size={14} />
                  Create your first monitor
                </Link>
              )
            }
          />
        </div>
      ) : null}

      {monitors.length > 0 ? (
        <div className="monitor-grid">
          {monitors.map((monitor) => (
            <MonitorCard key={monitor.id} monitor={monitor} />
          ))}
        </div>
      ) : null}

      <Pager
        hasMore={query.data?.hasMore ?? false}
        canPrevious={paging.canPrevious}
        onNext={() => paging.next(query.data?.nextCursor ?? null)}
        onPrevious={paging.previous}
        loading={query.isFetching}
      />
    </div>
  );
}

function MonitorCard({ monitor }: { monitor: MonitorSummary }) {
  const capture = useCaptureNow(monitor.id);

  const thumbnail = monitor.latestScreenshotUrl ? (
    <img
      src={monitor.latestScreenshotUrl}
      alt={`Latest screenshot of ${monitor.name}`}
      loading="lazy"
      decoding="async"
    />
  ) : (
    <span className="monitor-card__thumb-empty">
      {monitor.consecutiveFailures > 0
        ? 'No successful capture yet'
        : 'No capture yet — run one to get a baseline'}
    </span>
  );

  return (
    <article className="monitor-card">
      <Link
        to={`/monitors/${monitor.id}`}
        className="monitor-card__thumb"
        aria-label={`Open ${monitor.name}`}
      >
        {thumbnail}
        <span className="monitor-card__badge">
          <StatusBadge status={monitor.status} />
        </span>
      </Link>

      <div className="monitor-card__body">
        <Link to={`/monitors/${monitor.id}`} className="monitor-card__name">
          {monitor.name}
        </Link>
        <div className="monitor-card__url" title={monitor.url}>
          {monitor.url}
        </div>

        {monitor.tags.length > 0 ? (
          <div className="monitor-card__tags">
            {monitor.tags.map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
          </div>
        ) : null}

        {monitor.consecutiveFailures > 0 ? (
          <div className="small" style={{ color: 'var(--failing)' }}>
            {monitor.consecutiveFailures} consecutive capture failure
            {monitor.consecutiveFailures === 1 ? '' : 's'}
          </div>
        ) : null}

        <div className="monitor-card__meta">
          <span>
            <TimeAgo value={monitor.lastCheckedAt ?? monitor.lastRunAt} />
          </span>
          <Sparkline values={monitor.changeSparkline} />
        </div>

        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => capture.mutate()}
            disabled={capture.isPending}
            title="Capture this monitor now"
          >
            <IconCamera size={13} />
            {capture.isPending ? 'Capturing…' : 'Capture now'}
          </button>
          {monitor.recentChangeCount > 0 ? (
            <span className="small faint">
              {monitor.recentChangeCount} change{monitor.recentChangeCount === 1 ? '' : 's'} / 30d
            </span>
          ) : null}
        </div>
      </div>
    </article>
  );
}
