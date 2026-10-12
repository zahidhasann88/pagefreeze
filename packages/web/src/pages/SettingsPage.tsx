import { useState, type FormEvent } from 'react';
import {
  useChannels,
  useCreateChannel,
  useCreateToken,
  useDeleteChannel,
  useRevokeToken,
  useSystemInfo,
  useTestChannel,
  useTokens,
} from '../api/hooks.js';
import {
  AbsoluteTime,
  Alert,
  CopyButton,
  EmptyState,
  ErrorState,
  LoadingState,
  TimeAgo,
  bytesLabel,
  describeError,
} from '../components/ui.js';
import { IconCheck, IconPlus, IconTrash } from '../components/Icons.js';
import type { ChannelType } from '@pagefreeze/shared';

/**
 * Settings: API tokens, notification channels, retention and read-only system info.
 *
 * Retention is displayed here but configured on the server (globally) or per monitor:
 * changing it from the UI would silently delete history, so it stays an operator decision
 * made in configuration where it is version-controlled and reviewed.
 */
export function SettingsPage() {
  return (
    <div className="stack">
      <div className="page-head">
        <div className="page-head__title">
          <h1>Settings</h1>
          <div className="page-head__subtitle">
            Credentials for scripts, where notifications go, and what this instance is doing.
          </div>
        </div>
      </div>

      <TokensCard />
      <ChannelsCard />
      <SystemCard />
    </div>
  );
}

function TokensCard() {
  const tokensQuery = useTokens();
  const create = useCreateToken();
  const revoke = useRevokeToken();

  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState<string>('365');
  const [revealed, setRevealed] = useState<{ token: string; name: string } | null>(null);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!name.trim()) return;
    create.mutate(
      {
        name: name.trim(),
        expiresInDays: expiresInDays === 'never' ? null : Number.parseInt(expiresInDays, 10),
      },
      {
        onSuccess: (created) => {
          setRevealed({ token: created.token, name: created.name });
          setName('');
        },
      },
    );
  };

  return (
    <div className="card">
      <div className="card__head">
        <h2>API tokens</h2>
        <span className="grow" />
        <span className="small faint">Bearer authentication for scripts and CI</span>
      </div>
      <div className="card__body stack">
        <Alert kind="info">
          A token is shown exactly once, here, at creation time. Only a SHA-256 hash is stored, so
          it cannot be recovered later — if you lose it, revoke it and create another. Send it as{' '}
          <code>Authorization: Bearer &lt;token&gt;</code>. Bearer requests do not need the CSRF
          header.
        </Alert>

        {revealed ? (
          <div className="token-reveal" role="status">
            <code>{revealed.token}</code>
            <CopyButton value={revealed.token} label="Copy token" />
            <button type="button" className="btn btn--sm" onClick={() => setRevealed(null)}>
              Done
            </button>
          </div>
        ) : null}

        {create.isError ? <Alert kind="error">{describeError(create.error)}</Alert> : null}

        <form onSubmit={onSubmit} className="row" style={{ gap: 8 }}>
          <div className="field grow">
            <label className="field__label" htmlFor="token-name">
              Name
            </label>
            <input
              id="token-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="deploy checker"
              maxLength={200}
              required
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="token-expiry">
              Expires
            </label>
            <select
              id="token-expiry"
              className="select"
              value={expiresInDays}
              onChange={(event) => setExpiresInDays(event.target.value)}
            >
              <option value="30">in 30 days</option>
              <option value="90">in 90 days</option>
              <option value="365">in a year</option>
              <option value="never">never</option>
            </select>
          </div>
          <div className="field">
            <span className="field__label" aria-hidden="true">
              &nbsp;
            </span>
            <button type="submit" className="btn btn--primary" disabled={create.isPending}>
              <IconPlus size={14} />
              {create.isPending ? 'Creating…' : 'Create token'}
            </button>
          </div>
        </form>

        {tokensQuery.isLoading ? <LoadingState label="Loading tokens…" /> : null}
        {tokensQuery.isError ? <ErrorState error={tokensQuery.error} /> : null}

        {tokensQuery.data && tokensQuery.data.data.length === 0 ? (
          <EmptyState title="No API tokens" body="Create one to drive Pagefreeze from a script." />
        ) : null}

        {tokensQuery.data && tokensQuery.data.data.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <caption className="sr-only">API tokens, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Prefix</th>
                  <th scope="col">Created</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Last used</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tokensQuery.data.data.map((token) => {
                  const revoked = token.revokedAt !== null;
                  return (
                    <tr key={token.id} style={revoked ? { opacity: 0.55 } : undefined}>
                      <td>
                        {token.name}
                        {revoked ? <span className="faint small"> (revoked)</span> : null}
                      </td>
                      <td className="mono faint">{token.prefix}…</td>
                      <td>
                        <TimeAgo value={token.createdAt} />
                      </td>
                      <td>{token.expiresAt ? <TimeAgo value={token.expiresAt} /> : 'never'}</td>
                      <td>
                        <TimeAgo value={token.lastUsedAt} />
                      </td>
                      <td>
                        {revoked ? null : (
                          <button
                            type="button"
                            className="btn btn--sm"
                            onClick={() => revoke.mutate(token.id)}
                            disabled={revoke.isPending}
                          >
                            <IconTrash size={13} />
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}
interface ChannelDraft {
  name: string;
  type: ChannelType;
  url: string;
  secret: string;
  to: string;
}

const emptyDraft: ChannelDraft = { name: '', type: 'webhook', url: '', secret: '', to: '' };

function ChannelsCard() {
  const channelsQuery = useChannels();
  const create = useCreateChannel();
  const remove = useDeleteChannel();

  const [draft, setDraft] = useState<ChannelDraft>(emptyDraft);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setError(null);

    let config: Record<string, unknown>;
    if (draft.type === 'email') {
      const to = draft.to
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (to.length === 0) {
        setError('Enter at least one recipient address.');
        return;
      }
      config = { to };
    } else {
      if (!draft.url.trim()) {
        setError('Enter the destination URL.');
        return;
      }
      config = {
        url: draft.url.trim(),
        ...(draft.type === 'webhook' && draft.secret ? { secret: draft.secret } : {}),
      };
    }

    create.mutate(
      { name: draft.name.trim() || `${draft.type} channel`, type: draft.type, config },
      {
        onSuccess: () => setDraft(emptyDraft),
        onError: (cause) => setError(describeError(cause)),
      },
    );
  };

  return (
    <div className="card">
      <div className="card__head">
        <h2>Notification channels</h2>
        <span className="grow" />
        <span className="small faint">Attach these to monitors</span>
      </div>
      <div className="card__body stack">
        <Alert kind="info">
          Webhooks are HMAC-signed: <code>X-Pagefreeze-Signature: sha256=…</code> over{' '}
          <code>timestamp.body</code>, with the timestamp in <code>X-Pagefreeze-Timestamp</code>.
          The signing secret is encrypted at rest and is never returned after creation. Destinations
          are checked by the same SSRF guard that protects captures.
        </Alert>

        {error ? <Alert kind="error">{error}</Alert> : null}

        {channelsQuery.isLoading ? <LoadingState label="Loading channels…" /> : null}
        {channelsQuery.isError ? <ErrorState error={channelsQuery.error} /> : null}

        {channelsQuery.data && channelsQuery.data.data.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <caption className="sr-only">Notification channels</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Type</th>
                  <th scope="col">Destination</th>
                  <th scope="col">Last delivery</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {channelsQuery.data.data.map((channel) => (
                  <ChannelRow
                    key={channel.id}
                    channel={channel}
                    onDelete={() => remove.mutate(channel.id)}
                    deleting={remove.isPending}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <form onSubmit={onSubmit} className="form-grid">
          <div className="field">
            <label className="field__label" htmlFor="ch-type">
              Type
            </label>
            <select
              id="ch-type"
              className="select"
              value={draft.type}
              onChange={(event) => setDraft({ ...draft, type: event.target.value as ChannelType })}
            >
              <option value="webhook">Generic webhook (JSON, HMAC signed)</option>
              <option value="slack">Slack-compatible incoming webhook</option>
              <option value="email">Email (SMTP)</option>
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="ch-name">
              Name
            </label>
            <input
              id="ch-name"
              className="input"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="Ops alerts"
            />
          </div>

          {draft.type === 'email' ? (
            <div className="field">
              <label className="field__label" htmlFor="ch-to">
                Recipients (comma separated)
              </label>
              <input
                id="ch-to"
                className="input"
                value={draft.to}
                onChange={(event) => setDraft({ ...draft, to: event.target.value })}
                placeholder="ops@example.com, legal@example.com"
              />
              <span className="field__hint">
                Requires SMTP_HOST to be configured on the server.
              </span>
            </div>
          ) : (
            <div className="field">
              <label className="field__label" htmlFor="ch-url">
                Destination URL
              </label>
              <input
                id="ch-url"
                className="input input--mono"
                type="url"
                value={draft.url}
                onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                placeholder="https://hooks.example.com/pagefreeze"
              />
            </div>
          )}

          {draft.type === 'webhook' ? (
            <div className="field">
              <label className="field__label" htmlFor="ch-secret">
                Signing secret
              </label>
              <input
                id="ch-secret"
                className="input input--mono"
                type="password"
                autoComplete="new-password"
                value={draft.secret}
                onChange={(event) => setDraft({ ...draft, secret: event.target.value })}
                placeholder="at least 8 characters"
              />
              <span className="field__hint">
                Optional, but strongly recommended: it is how the receiver proves the delivery came
                from you.
              </span>
            </div>
          ) : null}

          <div className="field">
            <span className="field__label" aria-hidden="true">
              &nbsp;
            </span>
            <button type="submit" className="btn btn--primary" disabled={create.isPending}>
              <IconPlus size={14} />
              {create.isPending ? 'Creating…' : 'Add channel'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ChannelRow({
  channel,
  onDelete,
  deleting,
}: {
  channel: {
    id: string;
    name: string;
    type: ChannelType;
    enabled: boolean;
    config: Record<string, unknown>;
  };
  onDelete: () => void;
  deleting: boolean;
}) {
  const test = useTestChannel(channel.id);
  const config = channel.config as { url?: string; to?: string[]; hasSecret?: boolean };

  const destination =
    channel.type === 'email'
      ? (config.to ?? []).join(', ')
      : (config.url ?? '').replace(/^https?:\/\//, '');

  return (
    <tr>
      <td>
        {channel.name}
        {channel.enabled ? null : <span className="faint small"> (disabled)</span>}
      </td>
      <td>
        <span className="tag">{channel.type}</span>
        {config.hasSecret ? (
          <span className="small faint" title="HMAC signing is configured">
            {' '}
            signed
          </span>
        ) : null}
      </td>
      <td
        className="mono small"
        title={channel.type === 'email' ? destination : `https://${destination}`}
      >
        {destination || '—'}
      </td>
      <td>
        {test.data ? (
          test.data.ok ? (
            <span style={{ color: 'var(--ok)' }}>
              <IconCheck size={12} /> delivered ({test.data.durationMs} ms)
            </span>
          ) : (
            <span style={{ color: 'var(--failing)' }} title={test.data.error ?? undefined}>
              failed: {test.data.error ?? `status ${test.data.status ?? '?'}`}
            </span>
          )
        ) : (
          <span className="faint small">not tested</span>
        )}
      </td>
      <td>
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => test.mutate(undefined)}
            disabled={test.isPending}
          >
            {test.isPending ? 'Sending…' : 'Send test'}
          </button>
          <button type="button" className="btn btn--sm" onClick={onDelete} disabled={deleting}>
            <IconTrash size={13} />
            <span className="sr-only">Delete {channel.name}</span>
          </button>
        </div>
      </td>
    </tr>
  );
}

function SystemCard() {
  const info = useSystemInfo();

  return (
    <div className="card">
      <div className="card__head">
        <h2>System</h2>
        <span className="grow" />
        <span className="small faint">read only</span>
      </div>
      <div className="card__body">
        {info.isLoading ? <LoadingState label="Loading system info…" /> : null}
        {info.isError ? (
          <ErrorState error={info.error} onRetry={() => void info.refetch()} />
        ) : null}

        {info.data ? (
          <div className="stack">
            <dl className="kv">
              <dt>Version</dt>
              <dd>{info.data.version}</dd>
              <dt>Runtime</dt>
              <dd>
                node {info.data.node} · {info.data.platform}
              </dd>
              <dt>Process mode</dt>
              <dd>{info.data.mode}</dd>
              <dt>Uptime</dt>
              <dd>{Math.round(info.data.uptimeSeconds / 60)} minutes</dd>
              <dt>Database</dt>
              <dd>
                PostgreSQL {info.data.database.version ?? 'unknown'} ·{' '}
                {bytesLabel(info.data.database.sizeBytes)}
              </dd>
              <dt>Storage</dt>
              <dd>
                {info.data.storage.driver} · {info.data.storage.snapshots} snapshot(s) ·{' '}
                {bytesLabel(info.data.storage.bytes)} of artefacts
              </dd>
              <dt>Capture</dt>
              <dd>
                concurrency {info.data.capture.concurrency} · timeout{' '}
                {Math.round(info.data.capture.timeoutMs / 1000)}s · retries{' '}
                {info.data.capture.retries} · chromium{' '}
                {info.data.capture.browserRunning ? 'running' : 'not launched'}
              </dd>
              <dt>Retention</dt>
              <dd>
                {info.data.retentionDays} days by default; a monitor can override it. The newest
                snapshot is always kept.
              </dd>
              <dt>Politeness</dt>
              <dd>minimum interval {info.data.minIntervalMinutes} minute(s) between runs</dd>
              <dt>SSRF policy</dt>
              <dd>
                private addresses{' '}
                {info.data.ssrf.allowPrivateTargets
                  ? 'ALLOWED (ALLOW_PRIVATE_TARGETS=true)'
                  : 'blocked'}
                {info.data.ssrf.allowedHosts.length > 0 ? (
                  <> · allowlisted: {info.data.ssrf.allowedHosts.join(', ')}</>
                ) : null}
              </dd>
              <dt>Scheduler</dt>
              <dd>
                {info.data.scheduler.enabled
                  ? `active · ${info.data.scheduler.queueDepth} job(s) queued`
                  : 'not running in this process'}
              </dd>
              <dt>Counts</dt>
              <dd>
                {info.data.counts.monitors} monitor(s) · {info.data.counts.snapshots} snapshot(s) ·{' '}
                {info.data.counts.changes} change(s)
              </dd>
              <dt>Read at</dt>
              <dd>
                <AbsoluteTime value={new Date().toISOString()} />
              </dd>
            </dl>

            <p className="small faint" style={{ margin: 0 }}>
              Endpoints: <code>GET /healthz</code> (liveness), <code>GET /readyz</code> (database,
              storage and browser), <code>GET /metrics</code> (Prometheus).
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
