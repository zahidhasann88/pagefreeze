import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useCompare, useMonitor, useSnapshots } from '../api/hooks.js';
import {
  AbsoluteTime,
  Alert,
  EmptyState,
  ErrorState,
  LoadingState,
  percentLabel,
} from '../components/ui.js';
import { IconArrowLeft, IconLayers } from '../components/Icons.js';
import { VisualDiff } from '../viewer/VisualDiff.js';
import { TextDiff } from '../viewer/TextDiff.js';
import { HtmlDiff } from '../viewer/HtmlDiff.js';

/**
 * Compare any two snapshots of one monitor, on demand.
 *
 * The comparison is computed but not stored (`store=false`), so exploring history does not
 * add rows to the change list. The two ids may be given in either order: the server sorts
 * them chronologically and "before" is always the older capture.
 */
export function ComparePage() {
  const { monitorId = '' } = useParams<{ monitorId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const monitorQuery = useMonitor(monitorId);
  const snapshotsQuery = useSnapshots(monitorId, { limit: 100, status: 'success' });

  const [a, setA] = useState(searchParams.get('a') ?? '');
  const [b, setB] = useState(searchParams.get('b') ?? '');
  const [tab, setTab] = useState<'visual' | 'text' | 'html'>('visual');

  // Pick a sensible default pair (the two newest captures) once snapshots have loaded.
  useEffect(() => {
    if (a || b) return;
    const snapshots = snapshotsQuery.data?.data ?? [];
    if (snapshots.length >= 2) {
      setA(snapshots[1]!.id);
      setB(snapshots[0]!.id);
    }
  }, [snapshotsQuery.data, a, b]);

  const compareQuery = useCompare(a || undefined, b || undefined, false);

  const updatePair = (nextA: string, nextB: string): void => {
    setA(nextA);
    setB(nextB);
    const params = new URLSearchParams();
    if (nextA) params.set('a', nextA);
    if (nextB) params.set('b', nextB);
    setSearchParams(params, { replace: true });
  };

  if (monitorQuery.isLoading) return <LoadingState label="Loading monitor…" />;
  if (monitorQuery.isError) return <ErrorState error={monitorQuery.error} />;

  const monitor = monitorQuery.data;
  const snapshots = (snapshotsQuery.data?.data ?? []).filter(
    (snapshot) => snapshot.status === 'success',
  );

  return (
    <div className="stack">
      <div className="page-head">
        <div className="page-head__title">
          <div className="row" style={{ gap: 8, marginBottom: 4 }}>
            <Link
              to={`/monitors/${monitorId}`}
              className="btn btn--ghost btn--sm"
              aria-label="Back to monitor"
            >
              <IconArrowLeft size={14} />
            </Link>
            <h1>
              <IconLayers size={17} aria-hidden="true" /> Compare snapshots
            </h1>
          </div>
          <div className="page-head__subtitle">
            {monitor ? monitor.name : monitorId}
            {monitor ? (
              <>
                {' · '}
                <code>{monitor.url}</code>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {snapshots.length < 2 ? (
        <div className="card">
          <EmptyState
            title="At least two successful captures are needed"
            body="Run a capture now, then come back to compare any two points in this monitor's history."
          />
        </div>
      ) : null}

      {snapshots.length >= 2 ? (
        <div className="card">
          <div className="card__head">
            <h3>Choose two snapshots</h3>
          </div>
          <div className="card__body">
            <div className="form-grid">
              <div className="field">
                <label className="field__label" htmlFor="compare-a">
                  Snapshot A
                </label>
                <select
                  id="compare-a"
                  className="select"
                  value={a}
                  onChange={(event) => updatePair(event.target.value, b)}
                >
                  <option value="">Select…</option>
                  {snapshots.map((snapshot) => (
                    <option key={snapshot.id} value={snapshot.id}>
                      {new Date(snapshot.capturedAt).toLocaleString()}
                      {snapshot.duplicateOf ? ' (unchanged)' : ''}
                    </option>
                  ))}
                </select>
                {a ? <SnapshotMeta snapshots={snapshots} id={a} /> : null}
              </div>

              <div className="field">
                <label className="field__label" htmlFor="compare-b">
                  Snapshot B
                </label>
                <select
                  id="compare-b"
                  className="select"
                  value={b}
                  onChange={(event) => updatePair(a, event.target.value)}
                >
                  <option value="">Select…</option>
                  {snapshots.map((snapshot) => (
                    <option key={snapshot.id} value={snapshot.id}>
                      {new Date(snapshot.capturedAt).toLocaleString()}
                      {snapshot.duplicateOf ? ' (unchanged)' : ''}
                    </option>
                  ))}
                </select>
                {b ? <SnapshotMeta snapshots={snapshots} id={b} /> : null}
              </div>
            </div>

            {a && b && a === b ? (
              <Alert kind="warn">
                Choose two different snapshots — comparing one with itself is always identical.
              </Alert>
            ) : null}
          </div>
        </div>
      ) : null}

      {compareQuery.isLoading ? <LoadingState label="Comparing…" /> : null}
      {compareQuery.isError ? (
        <ErrorState error={compareQuery.error} onRetry={() => void compareQuery.refetch()} />
      ) : null}

      {compareQuery.data ? (
        <div className="card">
          <div className="card__body">
            <div className="viewer__summary">
              <div className="stat">
                <span className="stat__label">Pixels changed</span>
                <span className="stat__value stat__value--big">
                  {percentLabel(compareQuery.data.diff.pixelDiffPercent)}
                </span>
              </div>
              <div className="stat">
                <span className="stat__label">Text lines</span>
                <span className="stat__value">
                  {compareQuery.data.diff.text ? (
                    <>
                      <span style={{ color: 'var(--ok)' }}>
                        +{compareQuery.data.diff.text.added}
                      </span>{' '}
                      <span style={{ color: 'var(--failing)' }}>
                        -{compareQuery.data.diff.text.removed}
                      </span>
                    </>
                  ) : (
                    <span className="faint">off</span>
                  )}
                </span>
              </div>
              <div className="stat">
                <span className="stat__label">HTML lines</span>
                <span className="stat__value">
                  {compareQuery.data.diff.html ? (
                    <>
                      <span style={{ color: 'var(--ok)' }}>
                        +{compareQuery.data.diff.html.added}
                      </span>{' '}
                      <span style={{ color: 'var(--failing)' }}>
                        -{compareQuery.data.diff.html.removed}
                      </span>
                    </>
                  ) : (
                    <span className="faint">off</span>
                  )}
                </span>
              </div>
              <div className="stat">
                <span className="stat__label">Significant</span>
                <span className="stat__value">
                  {compareQuery.data.diff.significant ? 'yes' : 'no'}
                </span>
              </div>
            </div>
            <p className="small faint" style={{ margin: '10px 0 0' }}>
              Computed on demand and not stored, so it does not appear in the change history.
            </p>
          </div>
        </div>
      ) : null}

      {compareQuery.data ? (
        <div className="card">
          <div className="card__body card__body--flush">
            <div className="tabs" role="tablist" aria-label="Comparison type">
              {(
                [
                  ['visual', 'Visual'],
                  ['text', 'Text'],
                  ['html', 'HTML'],
                ] as Array<['visual' | 'text' | 'html', string]>
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  id={`compare-tab-${value}`}
                  aria-selected={tab === value}
                  aria-controls={`compare-panel-${value}`}
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
              id={`compare-panel-${tab}`}
              aria-labelledby={`compare-tab-${tab}`}
              style={{ padding: 16 }}
            >
              {tab === 'visual' ? (
                <VisualDiff
                  beforeUrl={`/api/v1/snapshots/${a}/screenshot`}
                  afterUrl={`/api/v1/snapshots/${b}/screenshot`}
                  diffUrl={null}
                  regions={compareQuery.data.diff.regions}
                  pixelDiffPercent={compareQuery.data.diff.pixelDiffPercent}
                  sizeChanged={compareQuery.data.diff.sizeChanged}
                  sizeFrom={compareQuery.data.diff.sizeFrom}
                  sizeTo={compareQuery.data.diff.sizeTo}
                  beforeLabel="Screenshot of the earlier capture"
                  afterLabel="Screenshot of the later capture"
                />
              ) : null}
              {tab === 'text' ? <TextDiff diff={compareQuery.data.diff.text} /> : null}
              {tab === 'html' ? <HtmlDiff diff={compareQuery.data.diff.html} /> : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SnapshotMeta({
  snapshots,
  id,
}: {
  snapshots: Array<{
    id: string;
    capturedAt: string;
    title: string | null;
    httpStatus: number | null;
  }>;
  id: string;
}) {
  const snapshot = snapshots.find((item) => item.id === id);
  if (!snapshot) return null;
  return (
    <span className="field__hint">
      <AbsoluteTime value={snapshot.capturedAt} />
      {snapshot.httpStatus !== null ? ` · HTTP ${snapshot.httpStatus}` : ''}
      {snapshot.title ? ` · ${snapshot.title}` : ''}
    </span>
  );
}
