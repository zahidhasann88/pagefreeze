import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useChange, useCreateShare, useRevokeShare, useShares } from '../api/hooks.js';
import { urls } from '../api/client.js';
import {
  AbsoluteTime,
  Alert,
  CopyButton,
  ErrorState,
  LoadingState,
  StatusBadge,
  describeError,
  durationLabel,
  percentLabel,
} from '../components/ui.js';
import {
  IconArrowLeft,
  IconArrowRight,
  IconCode,
  IconShare,
  IconText,
  IconColumns,
} from '../components/Icons.js';
import { VisualDiff } from '../viewer/VisualDiff.js';
import { TextDiff } from '../viewer/TextDiff.js';
import { HtmlDiff } from '../viewer/HtmlDiff.js';

type Tab = 'visual' | 'text' | 'html';

/**
 * The change viewer: the screen the whole product exists for.
 *
 * Three comparisons of the same pair of captures — pixels, visible text and normalised
 * markup — with previous/next navigation so a reviewer can walk a monitor's history
 * without going back to the timeline each time.
 */
export function ChangeViewerPage() {
  const { monitorId = '', changeId = '' } = useParams<{ monitorId: string; changeId: string }>();
  const navigate = useNavigate();
  const query = useChange(changeId);

  const [tab, setTab] = useState<Tab>('visual');

  if (query.isLoading) return <LoadingState label="Loading change…" />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        title="Could not load this change"
        onRetry={() => void query.refetch()}
      />
    );
  }

  const change = query.data;
  if (!change) return <ErrorState error="Change not found" />;

  const beforeLabel = `Screenshot before the change, captured ${
    change.fromSnapshotId ? '' : '(no baseline)'
  }`;
  const afterLabel = `Screenshot after the change, captured ${new Date(
    change.createdAt,
  ).toLocaleString()}`;

  const tabs: Array<{ value: Tab; label: string; icon: typeof IconColumns; count?: string }> = [
    {
      value: 'visual',
      label: 'Visual',
      icon: IconColumns,
      count: change.pixelDiffPercent !== null ? percentLabel(change.pixelDiffPercent) : undefined,
    },
    {
      value: 'text',
      label: 'Text',
      icon: IconText,
      count:
        change.textAdded !== null || change.textRemoved !== null
          ? `+${change.textAdded ?? 0}/-${change.textRemoved ?? 0}`
          : undefined,
    },
    {
      value: 'html',
      label: 'HTML',
      icon: IconCode,
      count:
        change.htmlAdded !== null || change.htmlRemoved !== null
          ? `+${change.htmlAdded ?? 0}/-${change.htmlRemoved ?? 0}`
          : undefined,
    },
  ];

  return (
    <div className="viewer">
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
            <h1>{change.monitor?.name ?? 'Change'}</h1>
            <StatusBadge
              status={change.significant ? 'changed' : 'ok'}
              label={change.significant ? 'Significant' : 'Minor'}
            />
          </div>
          <div className="page-head__subtitle">
            <AbsoluteTime value={change.createdAt} />
            {change.monitor?.url ? (
              <>
                {' · '}
                <code>{change.monitor.url}</code>
              </>
            ) : null}
          </div>
        </div>

        <div className="page-head__actions">
          <button
            type="button"
            className="btn"
            disabled={!change.navigation.newer}
            onClick={() =>
              change.navigation.newer &&
              navigate(`/monitors/${monitorId}/changes/${change.navigation.newer}`)
            }
            title="Newer change"
          >
            <IconArrowLeft size={14} />
            Newer
          </button>
          <button
            type="button"
            className="btn"
            disabled={!change.navigation.older}
            onClick={() =>
              change.navigation.older &&
              navigate(`/monitors/${monitorId}/changes/${change.navigation.older}`)
            }
            title="Older change"
          >
            Older
            <IconArrowRight size={14} />
          </button>
          <ShareMenu changeId={changeId} />
        </div>
      </div>

      <div className="card">
        <div className="card__body">
          <div className="viewer__summary">
            <div className="stat">
              <span className="stat__label">Pixels changed</span>
              <span className="stat__value stat__value--big">
                {percentLabel(change.pixelDiffPercent)}
              </span>
            </div>
            <div className="stat">
              <span className="stat__label">Changed / total</span>
              <span className="stat__value">
                {(change.changedPixels ?? 0).toLocaleString()} /{' '}
                {(change.totalPixels ?? 0).toLocaleString()}
              </span>
            </div>
            <div className="stat">
              <span className="stat__label">Text lines</span>
              <span className="stat__value">
                {change.textAdded === null && change.textRemoved === null ? (
                  <span className="faint">off</span>
                ) : (
                  <>
                    <span style={{ color: 'var(--ok)' }}>+{change.textAdded ?? 0}</span>{' '}
                    <span style={{ color: 'var(--failing)' }}>-{change.textRemoved ?? 0}</span>
                  </>
                )}
              </span>
            </div>
            <div className="stat">
              <span className="stat__label">HTML lines</span>
              <span className="stat__value">
                {change.htmlAdded === null && change.htmlRemoved === null ? (
                  <span className="faint">off</span>
                ) : (
                  <>
                    <span style={{ color: 'var(--ok)' }}>+{change.htmlAdded ?? 0}</span>{' '}
                    <span style={{ color: 'var(--failing)' }}>-{change.htmlRemoved ?? 0}</span>
                  </>
                )}
              </span>
            </div>
            <div className="stat">
              <span className="stat__label">Page size</span>
              <span className="stat__value">
                {change.sizeChanged ? (
                  <span style={{ color: 'var(--changed)' }}>
                    {change.sizeFrom ? `${change.sizeFrom.width}×${change.sizeFrom.height}` : '?'} →{' '}
                    {change.sizeTo ? `${change.sizeTo.width}×${change.sizeTo.height}` : '?'}
                  </span>
                ) : change.sizeTo ? (
                  `${change.sizeTo.width}×${change.sizeTo.height}`
                ) : (
                  '—'
                )}
              </span>
            </div>
            <div className="stat">
              <span className="stat__label">Diff time</span>
              <span className="stat__value">{durationLabel(change.durationMs)}</span>
            </div>
          </div>

          <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
            {change.summary}
          </p>

          {change.truncated ? (
            <Alert kind="warn">
              <span style={{ marginTop: 6, display: 'block' }}>
                This diff is large, so the stored copy is truncated for display. Download the raw
                files for the complete content:{' '}
                <a href={urls.text(change.fromSnapshotId ?? '')} download>
                  before text
                </a>
                {change.fromSnapshotId ? ' · ' : ''}
                <a href={urls.text(change.toSnapshotId)} download>
                  after text
                </a>{' '}
                ·{' '}
                <a href={urls.html(change.toSnapshotId)} download>
                  after HTML
                </a>
              </span>
            </Alert>
          ) : null}
        </div>
      </div>

      <div className="card">
        <div className="card__body card__body--flush">
          <div className="tabs" role="tablist" aria-label="Comparison type">
            {tabs.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.value}
                  type="button"
                  role="tab"
                  id={`tab-${item.value}`}
                  aria-selected={tab === item.value}
                  aria-controls={`panel-${item.value}`}
                  className="tabs__tab"
                  onClick={() => setTab(item.value)}
                >
                  <Icon size={14} />
                  {item.label}
                  {item.count ? <span className="tabs__count">{item.count}</span> : null}
                </button>
              );
            })}
          </div>

          <div
            className="tab-panel"
            role="tabpanel"
            id={`panel-${tab}`}
            aria-labelledby={`tab-${tab}`}
            style={{ padding: 16 }}
          >
            {tab === 'visual' ? (
              <VisualDiff
                beforeUrl={change.fromSnapshotId ? urls.screenshot(change.fromSnapshotId) : null}
                afterUrl={urls.screenshot(change.toSnapshotId)}
                diffUrl={change.hasDiffImage ? urls.diffImage(change.id) : null}
                regions={change.regions}
                pixelDiffPercent={change.pixelDiffPercent}
                sizeChanged={change.sizeChanged}
                sizeFrom={change.sizeFrom}
                sizeTo={change.sizeTo}
                beforeLabel={beforeLabel}
                afterLabel={afterLabel}
              />
            ) : null}

            {tab === 'text' ? <TextDiff diff={change.textDiff} /> : null}
            {tab === 'html' ? <HtmlDiff diff={change.htmlDiff} /> : null}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card__head">
          <h3>Snapshots in this comparison</h3>
        </div>
        <div className="card__body">
          <dl className="kv">
            <dt>Before</dt>
            <dd>
              {change.fromSnapshotId ? (
                <Link
                  to={`/monitors/${monitorId}/compare?a=${change.fromSnapshotId}&b=${change.toSnapshotId}`}
                >
                  {change.fromSnapshotId}
                </Link>
              ) : (
                <span className="faint">none — first successful capture</span>
              )}
            </dd>
            <dt>After</dt>
            <dd>{change.toSnapshotId}</dd>
            <dt>Raw files</dt>
            <dd>
              <a href={urls.screenshot(change.toSnapshotId)} download>
                after PNG
              </a>{' '}
              ·{' '}
              <a href={urls.html(change.toSnapshotId)} download>
                after HTML
              </a>{' '}
              ·{' '}
              <a href={urls.text(change.toSnapshotId)} download>
                after text
              </a>
              {change.fromSnapshotId ? (
                <>
                  {' · '}
                  <a href={urls.screenshot(change.fromSnapshotId)} download>
                    before PNG
                  </a>
                </>
              ) : null}
            </dd>
          </dl>
        </div>
      </div>
    </div>
  );
}

/**
 * Share-link menu.
 *
 * Creating a link exposes one change, read-only, to anyone holding the URL. The privacy
 * consequence is stated in the UI rather than only in the docs, because the person creating
 * the link is the one who needs to know.
 */
function ShareMenu({ changeId }: { changeId: string }) {
  const [open, setOpen] = useState(false);
  const [expiresInHours, setExpiresInHours] = useState<number | null>(168);
  const sharesQuery = useShares(changeId);
  const create = useCreateShare(changeId);
  const revoke = useRevokeShare(changeId);

  const onCreate = (): void => {
    create.mutate(expiresInHours, { onSuccess: () => setOpen(true) });
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        className="btn"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <IconShare size={14} />
        Share
      </button>

      {open ? (
        <div
          className="card"
          role="dialog"
          aria-label="Share this change"
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 6px)',
            width: 'min(420px, 90vw)',
            zIndex: 30,
            boxShadow: 'var(--shadow-md)',
          }}
        >
          <div className="card__head">
            <h3>Share this change</h3>
            <span className="grow" />
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setOpen(false)}
              aria-label="Close share dialog"
            >
              ×
            </button>
          </div>
          <div className="card__body stack">
            <Alert kind="warn">
              Anyone with the link sees the screenshots, extracted text and HTML diff of both
              captures — no account needed. If this page is behind a login, that content may include
              account-specific data. The URL is a bearer credential: forwarding it forwards access.
            </Alert>

            {create.isError ? <Alert kind="error">{describeError(create.error)}</Alert> : null}

            <div className="field">
              <label className="field__label" htmlFor="share-expiry">
                Expiry
              </label>
              <select
                id="share-expiry"
                className="select"
                value={expiresInHours === null ? 'never' : String(expiresInHours)}
                onChange={(event) =>
                  setExpiresInHours(
                    event.target.value === 'never' ? null : Number.parseInt(event.target.value, 10),
                  )
                }
              >
                <option value="24">Expires in 24 hours</option>
                <option value="168">Expires in 7 days</option>
                <option value="720">Expires in 30 days</option>
                <option value="never">Never expires</option>
              </select>
            </div>

            <button
              type="button"
              className="btn btn--primary"
              onClick={onCreate}
              disabled={create.isPending}
            >
              {create.isPending ? 'Creating…' : 'Create link'}
            </button>

            {create.data?.url ? (
              // The token is hashed at rest, so this is the only moment the full URL exists.
              // Showing it beats a clipboard-only reveal: the operator can read it back.
              <div className="token-reveal" role="status">
                <code>{create.data.url}</code>
                <CopyButton value={create.data.url} label="Copy URL" />
              </div>
            ) : null}

            {sharesQuery.data?.data && sharesQuery.data.data.length > 0 ? (
              <div className="stack" style={{ gap: 8 }}>
                <span className="field__label">Existing links</span>
                {sharesQuery.data.data.map((share) => (
                  <div key={share.id} className="row" style={{ gap: 6 }}>
                    <span className="small grow">
                      {share.active ? (
                        <>
                          {share.viewCount ?? 0} view{(share.viewCount ?? 0) === 1 ? '' : 's'} ·{' '}
                          {share.expiresAt ? (
                            <>
                              expires <AbsoluteTime value={share.expiresAt} />
                            </>
                          ) : (
                            'no expiry'
                          )}
                        </>
                      ) : (
                        <span className="faint">
                          revoked
                          {share.revokedAt ? <AbsoluteTime value={share.revokedAt} /> : null}
                        </span>
                      )}
                    </span>
                    {share.url ? <CopyButton value={share.url} label="Copy URL" /> : null}
                    {share.active ? (
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => revoke.mutate(share.id)}
                        disabled={revoke.isPending}
                      >
                        Revoke
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
