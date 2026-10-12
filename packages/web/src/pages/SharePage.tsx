import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../api/client.js';
import type { ShareView } from '../api/types.js';
import { AbsoluteTime, Alert, ErrorState, LoadingState, percentLabel } from '../components/ui.js';
import { Logo } from '../components/Icons.js';
import { VisualDiff } from '../viewer/VisualDiff.js';

/**
 * Public share view.
 *
 * Deliberately minimal: no navigation, no links into the rest of the app, and no way to
 * reach anything other than the single shared change. Artefacts are loaded through the
 * token-scoped endpoints, so holding a share link never widens access to the monitor's
 * history.
 */
export function SharePage() {
  const { token = '' } = useParams<{ token: string }>();
  const [tab, setTab] = useState<'visual' | 'summary'>('visual');

  const query = useQuery({
    queryKey: ['share', token],
    queryFn: ({ signal }) => apiRequest<ShareView>(`/share/${token}`, { signal }),
    retry: false,
  });

  if (query.isLoading) {
    return (
      <div className="share-page">
        <LoadingState label="Loading the shared change…" />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="share-page">
        <ShareHeader />
        <ErrorState error={query.error} title="This share link is not available" />
        <p className="small muted" style={{ textAlign: 'center' }}>
          It may have been revoked, or it may have expired. Ask whoever sent it for a new link.
        </p>
      </div>
    );
  }

  const view = query.data;
  const { change } = view;

  return (
    <div className="share-page">
      <ShareHeader />

      <div className="stack">
        <div className="card">
          <div className="card__body">
            <h1 style={{ marginBottom: 6 }}>{view.monitor.name ?? 'A monitored page'} changed</h1>
            <div className="small muted" style={{ marginBottom: 14, overflowWrap: 'anywhere' }}>
              {view.monitor.url ? <code>{view.monitor.url}</code> : null}
              {' · '}
              <AbsoluteTime value={change.createdAt} />
            </div>

            <div className="viewer__summary">
              <div className="stat">
                <span className="stat__label">Pixels changed</span>
                <span className="stat__value stat__value--big">
                  {percentLabel(change.pixelDiffPercent)}
                </span>
              </div>
              <div className="stat">
                <span className="stat__label">Text lines</span>
                <span className="stat__value">
                  {change.textAdded === null && change.textRemoved === null ? (
                    <span className="faint">not compared</span>
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
                    <span className="faint">not compared</span>
                  ) : (
                    <>
                      <span style={{ color: 'var(--ok)' }}>+{change.htmlAdded ?? 0}</span>{' '}
                      <span style={{ color: 'var(--failing)' }}>-{change.htmlRemoved ?? 0}</span>
                    </>
                  )}
                </span>
              </div>
              <div className="stat">
                <span className="stat__label">Significant</span>
                <span className="stat__value">{change.significant ? 'yes' : 'no'}</span>
              </div>
            </div>

            <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
              {change.summary}
            </p>
          </div>
        </div>

        <Alert kind="info">
          This page shows one change from a Pagefreeze instance, to anyone holding the link. No
          account is required, and nothing else on that instance is reachable from here. What is
          visible: the two screenshots, the highlighted pixel differences and the change statistics.
          If the monitored page sits behind a login, that content may include account-specific
          information.
          {view.expiresAt ? (
            <>
              {' '}
              This link expires <AbsoluteTime value={view.expiresAt} /> and can be revoked at any
              time by whoever created it.
            </>
          ) : (
            <> It can be revoked at any time by whoever created it.</>
          )}
        </Alert>

        <div className="card">
          <div className="card__body card__body--flush">
            <div className="tabs" role="tablist" aria-label="Shared change">
              {(
                [
                  ['visual', 'Visual diff'],
                  ['summary', 'About this link'],
                ] as Array<['visual' | 'summary', string]>
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  id={`share-tab-${value}`}
                  aria-selected={tab === value}
                  aria-controls={`share-panel-${value}`}
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
              id={`share-panel-${tab}`}
              aria-labelledby={`share-tab-${tab}`}
              style={{ padding: 16 }}
            >
              {tab === 'visual' ? (
                <VisualDiff
                  beforeUrl={view.urls.before}
                  afterUrl={view.urls.after}
                  diffUrl={view.urls.diff}
                  regions={change.regions}
                  pixelDiffPercent={change.pixelDiffPercent}
                  sizeChanged={change.sizeChanged}
                  sizeFrom={change.sizeFrom}
                  sizeTo={change.sizeTo}
                  beforeLabel="Screenshot before the change"
                  afterLabel="Screenshot after the change"
                />
              ) : (
                <div className="stack">
                  <p className="small muted" style={{ margin: 0 }}>
                    If you received this link unexpectedly, treat it as sensitive and do not
                    redistribute it: the URL is a bearer credential, and whoever created the link
                    can see how many times it has been opened.
                  </p>
                  <dl className="kv">
                    <dt>Change id</dt>
                    <dd>{change.id}</dd>
                    <dt>Captured</dt>
                    <dd>
                      <AbsoluteTime value={change.createdAt} />
                    </dd>
                    <dt>Regions</dt>
                    <dd>{change.regions.length} changed region(s)</dd>
                  </dl>
                </div>
              )}
            </div>
          </div>
        </div>

        <p className="small faint" style={{ textAlign: 'center' }}>
          Shared from Pagefreeze — self-hosted website change monitoring.
        </p>
      </div>
    </div>
  );
}

function ShareHeader() {
  return (
    <div className="share-head">
      <Logo size={20} />
      <strong>Pagefreeze</strong>
      <span className="grow" />
      <span className="small faint">shared change · read only</span>
    </div>
  );
}
