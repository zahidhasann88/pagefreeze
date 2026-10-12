import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Change, Snapshot } from '@pagefreeze/shared';
import {
  useCaptureNow,
  useChanges,
  useChannels,
  useDeleteMonitor,
  useMonitor,
  useSetPaused,
  useSnapshots,
} from '../api/hooks.js';
import {
  AbsoluteTime,
  Alert,
  EmptyState,
  ErrorState,
  LoadingState,
  Pager,
  Sparkline,
  StatusBadge,
  Tag,
  TimeAgo,
  describeError,
  percentLabel,
  useCursorStack,
} from '../components/ui.js';
import {
  IconArrowLeft,
  IconCamera,
  IconEdit,
  IconLayers,
  IconPause,
  IconPlay,
  IconTrash,
} from '../components/Icons.js';
import { MonitorNotificationsTab, MonitorSettingsTab } from '../components/MonitorTabs.js';

type Tab = 'timeline' | 'settings' | 'notifications';

/** Long enough for a slow page, short enough that a lost job does not poll forever. */
const CAPTURE_POLL_WINDOW_MS = 120_000;

export function MonitorDetailPage() {
  const { monitorId = '' } = useParams<{ monitorId: string }>();
  const navigate = useNavigate();

  const [tab, setTab] = useState<Tab>('timeline');
  const [confirmDelete, setConfirmDelete] = useState(false);

  /**
   * A manual capture is accepted with 202 and then runs, so the new snapshot does not exist
   * yet when the mutation resolves. Poll until it appears, or until the deadline passes.
   */
  const [awaitingSince, setAwaitingSince] = useState<number | null>(null);
  const polling = awaitingSince !== null && Date.now() - awaitingSince < CAPTURE_POLL_WINDOW_MS;

  const monitorQuery = useMonitor(monitorId, { refetchIntervalMs: polling ? 2000 : false });
  const channelsQuery = useChannels();
  const capture = useCaptureNow(monitorId);
  const setPaused = useSetPaused(monitorId);
  const remove = useDeleteMonitor();

  if (monitorQuery.isLoading) return <LoadingState label="Loading monitor…" />;
  if (monitorQuery.isError) {
    return <ErrorState error={monitorQuery.error} onRetry={() => void monitorQuery.refetch()} />;
  }

  const monitor = monitorQuery.data;
  if (!monitor) return <ErrorState error="Monitor not found" />;

  const onDelete = (): void => {
    remove.mutate(monitorId, { onSuccess: () => navigate('/') });
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div className="page-head__title">
          <div className="row" style={{ gap: 8, marginBottom: 4 }}>
            <Link to="/" className="btn btn--ghost btn--sm" aria-label="Back to dashboard">
              <IconArrowLeft size={14} />
            </Link>
            <h1>{monitor.name}</h1>
            <StatusBadge status={monitor.status} />
          </div>
          <div className="page-head__subtitle">
            <code>{monitor.url}</code>
          </div>
        </div>

        <div className="page-head__actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setAwaitingSince(Date.now());
              capture.mutate();
            }}
            disabled={capture.isPending}
            aria-busy={capture.isPending || polling}
          >
            <IconCamera size={14} />
            {capture.isPending ? 'Queuing…' : polling ? 'Capturing…' : 'Capture now'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setPaused.mutate(!monitor.paused)}
            disabled={setPaused.isPending}
          >
            {monitor.paused ? <IconPlay size={14} /> : <IconPause size={14} />}
            {monitor.paused ? 'Resume' : 'Pause'}
          </button>
          <Link to={`/monitors/${monitorId}/edit`} className="btn">
            <IconEdit size={14} />
            Edit
          </Link>
          <Link to={`/monitors/${monitorId}/compare`} className="btn">
            <IconLayers size={14} />
            Compare
          </Link>
        </div>
      </div>

      {capture.isError ? <Alert kind="error">{describeError(capture.error)}</Alert> : null}
      {setPaused.isError ? <Alert kind="error">{describeError(setPaused.error)}</Alert> : null}
      {remove.isError ? <Alert kind="error">{describeError(remove.error)}</Alert> : null}

      {monitor.consecutiveFailures > 0 ? (
        <Alert kind="warn">
          {monitor.consecutiveFailures} consecutive capture failure
          {monitor.consecutiveFailures === 1 ? '' : 's'}. Snapshots are recorded with the error
          message; no changes are computed from a failed capture.
        </Alert>
      ) : null}

      <div className="card">
        <div className="card__body">
          <div className="row" style={{ gap: 26, flexWrap: 'wrap' }}>
            <div className="stat">
              <span className="stat__label">Last checked</span>
              <span className="stat__value" style={{ fontSize: 14 }}>
                <TimeAgo value={monitor.lastSnapshotAt ?? monitor.lastRunAt} />
              </span>
            </div>
            <div className="stat">
              <span className="stat__label">Last change</span>
              <span className="stat__value" style={{ fontSize: 14 }}>
                <TimeAgo value={monitor.lastChangeAt} />
              </span>
            </div>
            <div className="stat">
              <span className="stat__label">Next run</span>
              <span className="stat__value" style={{ fontSize: 14 }}>
                {monitor.nextRunAt ? <AbsoluteTime value={monitor.nextRunAt} /> : 'paused'}
              </span>
            </div>
            <div className="stat">
              <span className="stat__label">Schedule</span>
              <span
                className="stat__value"
                style={{ fontSize: 14, fontFamily: 'var(--font-sans)' }}
              >
                {monitor.scheduleDescription}
              </span>
            </div>
            <div className="stat">
              <span className="stat__label">Threshold</span>
              <span className="stat__value" style={{ fontSize: 14 }}>
                {percentLabel(monitor.changeThreshold)}
              </span>
            </div>
            {monitor.tags.length > 0 ? (
              <div className="stat">
                <span className="stat__label">Tags</span>
                <span className="row" style={{ gap: 4 }}>
                  {monitor.tags.map((tag) => (
                    <Tag key={tag}>{tag}</Tag>
                  ))}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card__body card__body--flush">
          <div className="tabs" role="tablist" aria-label="Monitor sections">
            {(
              [
                ['timeline', 'Timeline'],
                ['settings', 'Settings'],
                ['notifications', 'Notifications'],
              ] as Array<[Tab, string]>
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                id={`tab-${value}`}
                aria-selected={tab === value}
                aria-controls={`panel-${value}`}
                className="tabs__tab"
                onClick={() => setTab(value)}
              >
                {label}
              </button>
            ))}
          </div>

          <div
            className="tab-panel"
            role="tabpanel"
            id={`panel-${tab}`}
            aria-labelledby={`tab-${tab}`}
            style={{ padding: '0 0 4px' }}
          >
            {tab === 'timeline' ? (
              <TimelineTab
                monitorId={monitorId}
                polling={polling}
                awaitingSince={awaitingSince}
                onSettled={() => setAwaitingSince(null)}
              />
            ) : null}
            {tab === 'settings' ? <MonitorSettingsTab monitor={monitor} /> : null}
            {tab === 'notifications' ? (
              <MonitorNotificationsTab
                monitor={monitor}
                channels={channelsQuery.data?.data ?? []}
              />
            ) : null}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card__head">
          <h3>Danger zone</h3>
        </div>
        <div className="card__body">
          {confirmDelete ? (
            <div className="stack">
              <Alert kind="warn">
                Deleting removes this monitor, all of its snapshots and changes, and the stored
                screenshots and HTML. This cannot be undone.
              </Alert>
              <div className="row">
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={onDelete}
                  disabled={remove.isPending}
                >
                  <IconTrash size={14} />
                  {remove.isPending ? 'Deleting…' : 'Yes, delete permanently'}
                </button>
                <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn" onClick={() => setConfirmDelete(true)}>
              <IconTrash size={14} />
              Delete monitor
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface TimelineEntry {
  id: string;
  when: string;
  snapshot: Snapshot;
  change: Change | null;
}

/**
 * One list combining snapshots and the changes they produced, newest first.
 *
 * The two collections are fetched separately and merged client-side, because the API pages
 * them independently and a change exists only for snapshots that had a successful
 * predecessor.
 */
function TimelineTab({
  monitorId,
  polling,
  awaitingSince,
  onSettled,
}: {
  monitorId: string;
  polling: boolean;
  awaitingSince: number | null;
  onSettled: () => void;
}) {
  const snapshotPaging = useCursorStack();
  const snapshotsQuery = useSnapshots(
    monitorId,
    {
      limit: 30,
      ...(snapshotPaging.cursor ? { cursor: snapshotPaging.cursor } : {}),
    },
    { refetchIntervalMs: polling ? 2000 : false },
  );
  const changesQuery = useChanges(
    monitorId,
    { limit: 100, significant: 'all' },
    { refetchIntervalMs: polling ? 2000 : false },
  );

  /**
   * Stop polling only once the new snapshot has reached a terminal state.
   *
   * A snapshot row is written first and its change row a moment later, after the diff has
   * been computed. Settling on "a new snapshot exists" therefore stops the refresh before
   * the change is visible, and the timeline would show a capture with no result until the
   * next manual reload. The terminal states are: failed, de-duplicated (nothing changed), or
   * carrying a changeId whose change has actually arrived in the changes query. The very
   * first capture of a monitor has no predecessor, so a single snapshot with no change is
   * also terminal.
   *
   * The snapshots and changes queries poll on independent intervals, so a snapshots tick can
   * see the new changeId while the changes query still holds its pre-diff page. Settling on
   * the changeId alone would then freeze the timeline with an empty change map (the row
   * would render as a baseline even though a change exists). Requiring the change object to
   * be loaded keeps polling for one more tick until both queries agree.
   */
  const snapshotRows = snapshotsQuery.data?.data ?? [];
  const newest = snapshotRows[0];
  const changeRows = changesQuery.data?.data ?? [];
  const newestChangeLoaded =
    newest !== undefined &&
    newest.changeId !== null &&
    changeRows.some((change) => change.toSnapshotId === newest.id);
  const baselineId = useRef<string | null>(null);

  // Record what was newest when the capture was requested, so "new" is unambiguous even if
  // the browser and server clocks disagree.
  useEffect(() => {
    if (awaitingSince !== null) baselineId.current = newest?.id ?? null;
    // Intentionally keyed only on awaitingSince: baselineId records what was newest
    // at the moment the capture was requested, independent of later snapshot arrivals.
  }, [awaitingSince]);

  useEffect(() => {
    if (awaitingSince === null || !newest) return;
    if (newest.id === baselineId.current) return;

    const settled =
      newest.status === 'failed' ||
      newest.duplicateOf !== null ||
      newestChangeLoaded ||
      (snapshotRows.length === 1 && newest.changeId === null);
    if (settled) onSettled();
  }, [awaitingSince, newest, snapshotRows.length, newestChangeLoaded, onSettled]);

  if (snapshotsQuery.isLoading) return <LoadingState label="Loading history…" />;
  if (snapshotsQuery.isError) {
    return (
      <ErrorState error={snapshotsQuery.error} onRetry={() => void snapshotsQuery.refetch()} />
    );
  }

  const snapshots = snapshotsQuery.data?.data ?? [];
  const changesBySnapshot = new Map<string, Change>();
  for (const change of changesQuery.data?.data ?? []) {
    changesBySnapshot.set(change.toSnapshotId, change);
  }

  const entries: TimelineEntry[] = snapshots.map((snapshot) => ({
    id: snapshot.id,
    when: snapshot.capturedAt,
    snapshot,
    change: snapshot.changeId ? (changesBySnapshot.get(snapshot.id) ?? null) : null,
  }));

  if (entries.length === 0) {
    return (
      <EmptyState
        title="No snapshots yet"
        body="Run a capture now to create the first baseline. Changes are computed from the second successful capture onwards."
      />
    );
  }

  const sparkline = new Array<number>(14).fill(0);
  for (const change of changesQuery.data?.data ?? []) {
    const days = Math.floor((Date.now() - new Date(change.createdAt).getTime()) / 86_400_000);
    const index = 13 - days;
    if (index >= 0 && index < 14) sparkline[index] = (sparkline[index] ?? 0) + 1;
  }

  return (
    <div>
      <div className="row row--between" style={{ padding: '12px 14px 4px' }}>
        <span className="small muted">
          {changesQuery.data?.data.length ?? 0} change(s) recorded
        </span>
        <Sparkline values={sparkline} />
      </div>

      <ul className="timeline">
        {entries.map((entry) => (
          <TimelineRow key={entry.id} entry={entry} monitorId={monitorId} />
        ))}
      </ul>

      <Pager
        hasMore={snapshotsQuery.data?.hasMore ?? false}
        canPrevious={snapshotPaging.canPrevious}
        onNext={() => snapshotPaging.next(snapshotsQuery.data?.nextCursor ?? null)}
        onPrevious={snapshotPaging.previous}
        loading={snapshotsQuery.isFetching}
      />
    </div>
  );
}

function TimelineRow({ entry, monitorId }: { entry: TimelineEntry; monitorId: string }) {
  const { snapshot, change } = entry;

  if (snapshot.status === 'failed') {
    return (
      <li className="timeline__item">
        <div className="timeline__row">
          <span className="timeline__marker timeline__marker--failed" aria-hidden="true" />
          <span className="timeline__when">
            <TimeAgo value={snapshot.capturedAt} />
          </span>
          <span className="timeline__what" title={snapshot.errorMessage ?? undefined}>
            <strong>Capture failed</strong>
            {snapshot.errorMessage ? (
              <span className="muted"> — {snapshot.errorMessage}</span>
            ) : null}
          </span>
          <span className="timeline__stats">
            {snapshot.httpStatus !== null ? `HTTP ${snapshot.httpStatus}` : ''}
          </span>
        </div>
      </li>
    );
  }

  if (!change) {
    return (
      <li className="timeline__item">
        <div className="timeline__row">
          <span className="timeline__marker" aria-hidden="true" />
          <span className="timeline__when">
            <TimeAgo value={snapshot.capturedAt} />
          </span>
          <span className="timeline__what">
            {snapshot.duplicateOf ? (
              <>
                <span className="muted">Unchanged</span> — identical to the previous capture, no new
                files stored
              </>
            ) : snapshot.changeId ? (
              // Transient: the snapshot references a change the changes query has not
              // delivered yet. Never label this a baseline — a change exists.
              <span className="muted">Change recorded — loading details…</span>
            ) : (
              <span className="muted">Baseline capture — nothing to compare against yet</span>
            )}
          </span>
          <span className="timeline__stats">
            {snapshot.screenshotWidth && snapshot.screenshotHeight
              ? `${snapshot.screenshotWidth}×${snapshot.screenshotHeight}`
              : ''}
          </span>
        </div>
      </li>
    );
  }

  return (
    <li className="timeline__item">
      <Link to={`/monitors/${monitorId}/changes/${change.id}`} className="timeline__row">
        <span
          className={
            change.significant
              ? 'timeline__marker timeline__marker--significant'
              : 'timeline__marker timeline__marker--changed'
          }
          aria-hidden="true"
        />
        <span className="timeline__when">
          <TimeAgo value={snapshot.capturedAt} />
        </span>
        <span className="timeline__what">
          <strong>{change.significant ? 'Significant change' : 'Minor change'}</strong>
          <span className="muted"> — {change.summary}</span>
        </span>
        <span className="timeline__stats">
          <span>{percentLabel(change.pixelDiffPercent)}</span>
          {change.textAdded !== null || change.textRemoved !== null ? (
            <span>
              text +{change.textAdded ?? 0}/-{change.textRemoved ?? 0}
            </span>
          ) : null}
          {change.sizeChanged ? <span>size changed</span> : null}
        </span>
      </Link>
    </li>
  );
}
