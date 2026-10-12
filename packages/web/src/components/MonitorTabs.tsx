import { Link } from 'react-router-dom';
import type { Monitor, NotificationChannel } from '@pagefreeze/shared';
import { useUpdateMonitor } from '../api/hooks.js';
import { Alert, EmptyState, describeError, percentLabel } from './ui.js';
import { IconEdit } from './Icons.js';

/** Read-only summary of every capture setting, with a link to the full editor. */
export function MonitorSettingsTab({ monitor }: { monitor: Monitor }) {
  return (
    <div className="card__body">
      <div className="row row--between" style={{ marginBottom: 12 }}>
        <h3>Capture settings</h3>
        <Link to={`/monitors/${monitor.id}/edit`} className="btn btn--sm">
          <IconEdit size={13} />
          Edit settings
        </Link>
      </div>

      <dl className="kv">
        <dt>Schedule</dt>
        <dd>
          {monitor.scheduleDescription}{' '}
          <span className="faint">
            ({monitor.scheduleKind === 'cron' ? monitor.scheduleValue : monitor.scheduleCron})
          </span>
        </dd>

        <dt>Device</dt>
        <dd>
          {monitor.devicePreset} — {monitor.viewportWidth}×{monitor.viewportHeight}
          {monitor.fullPage ? ', full page' : ', viewport only'}
        </dd>

        <dt>Wait strategy</dt>
        <dd>
          {monitor.waitStrategy}
          {monitor.waitStrategy === 'selector' && monitor.waitSelector
            ? ` → ${monitor.waitSelector}`
            : ''}
          {monitor.extraDelayMs > 0 ? `, +${monitor.extraDelayMs} ms` : ''}
        </dd>

        <dt>Capture selector</dt>
        <dd>{monitor.captureSelector ?? 'whole page'}</dd>

        <dt>Ignore selectors</dt>
        <dd>{monitor.ignoreSelectors.length > 0 ? monitor.ignoreSelectors.join(', ') : 'none'}</dd>

        <dt>User-Agent</dt>
        <dd>{monitor.userAgent ?? 'Pagefreeze default'}</dd>

        <dt>Change threshold</dt>
        <dd>{percentLabel(monitor.changeThreshold)} of pixels</dd>

        <dt>Detection</dt>
        <dd>
          visual always{monitor.detectText ? ', text' : ''}
          {monitor.detectHtml ? ', HTML' : ''}
        </dd>

        <dt>Retention</dt>
        <dd>{monitor.retentionDays ? `${monitor.retentionDays} days` : 'server default'}</dd>

        <dt>Custom headers</dt>
        <dd>
          {monitor.secrets.headerNames.length > 0 ? (
            <>
              {monitor.secrets.headerNames.join(', ')}{' '}
              <span className="faint">(values encrypted, never shown)</span>
            </>
          ) : (
            'none'
          )}
        </dd>

        <dt>Cookies</dt>
        <dd>
          {monitor.secrets.cookieNames.length > 0 ? (
            <>
              {monitor.secrets.cookieNames.join(', ')}{' '}
              <span className="faint">(values encrypted, never shown)</span>
            </>
          ) : (
            'none'
          )}
        </dd>

        <dt>Enabled</dt>
        <dd>{monitor.enabled ? 'yes' : 'no'}</dd>

        <dt>Monitor id</dt>
        <dd>{monitor.id}</dd>
      </dl>
    </div>
  );
}

export function MonitorNotificationsTab({
  monitor,
  channels,
}: {
  monitor: Monitor;
  channels: NotificationChannel[];
}) {
  const update = useUpdateMonitor(monitor.id);

  const toggle = (channelId: string, attach: boolean): void => {
    const next = attach
      ? [...new Set([...monitor.channelIds, channelId])]
      : monitor.channelIds.filter((id) => id !== channelId);
    update.mutate({ channelIds: next });
  };

  if (channels.length === 0) {
    return (
      <div className="card__body">
        <EmptyState
          title="No notification channels yet"
          body={
            <>
              Create a webhook, Slack or email channel in <Link to="/settings">Settings</Link>, then
              attach it here.
            </>
          }
        />
      </div>
    );
  }

  return (
    <div className="card__body">
      {update.isError ? <Alert kind="error">{describeError(update.error)}</Alert> : null}

      <p className="small muted" style={{ marginTop: 0 }}>
        A notification is sent when a <strong>significant</strong> change is recorded, after three
        consecutive capture failures, and once when the monitor recovers.
      </p>

      <div className="stack" style={{ gap: 8 }}>
        {channels.map((channel) => {
          const attached = monitor.channelIds.includes(channel.id);
          return (
            <label className="checkbox" key={channel.id} style={{ padding: '8px 0' }}>
              <input
                type="checkbox"
                checked={attached}
                disabled={update.isPending}
                onChange={(event) => toggle(channel.id, event.target.checked)}
              />
              <span>
                <strong>{channel.name}</strong>{' '}
                <span className="faint">
                  ({channel.type}
                  {channel.enabled ? '' : ', disabled'})
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
