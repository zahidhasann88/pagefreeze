import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  DEVICE_PRESET_KEYS,
  INTERVAL_PRESET_KEYS,
  INTERVAL_PRESET_LABELS,
  LIMITS,
  WAIT_STRATEGIES,
  describeCron,
  isValidCron,
  monitorDefaults,
  presetToCron,
  type DevicePreset,
  type WaitStrategy,
} from '@pagefreeze/shared';
import type { MonitorFormValues, NotificationChannel, PreviewResult } from '../api/types.js';
import { Alert, Spinner, bytesLabel, durationLabel } from './ui.js';
import { IconCamera } from './Icons.js';

export interface MonitorFormProps {
  initialValues?: Partial<MonitorFormValues>;
  channels: NotificationChannel[];
  submitting: boolean;
  submitLabel: string;
  onSubmit: (values: MonitorFormValues) => void;
  onCancel?: () => void;
  /** Existing secret names, shown read-only because values are never returned. */
  existingSecrets?: { headerNames: string[]; cookieNames: string[] };
  onPreview?: (values: MonitorFormValues) => Promise<PreviewResult | undefined>;
  previewPending?: boolean;
  submitError?: string | null;
}

const DEVICE_LABELS: Record<DevicePreset, string> = {
  desktop: 'Desktop',
  tablet: 'Tablet',
  mobile: 'Mobile',
};

const WAIT_LABELS: Record<WaitStrategy, string> = {
  load: 'Load event',
  networkidle: 'Network idle',
  selector: 'Wait for a selector',
};

function emptyForm(): MonitorFormValues {
  return {
    name: '',
    url: '',
    tags: [],
    enabled: true,
    scheduleKind: 'preset',
    scheduleValue: '24h',
    devicePreset: 'desktop',
    viewportWidth: monitorDefaults.viewportWidth,
    viewportHeight: monitorDefaults.viewportHeight,
    fullPage: true,
    waitStrategy: 'load',
    waitSelector: null,
    extraDelayMs: 0,
    captureSelector: null,
    ignoreSelectors: [],
    userAgent: null,
    changeThreshold: monitorDefaults.changeThreshold,
    detectText: true,
    detectHtml: true,
    retentionDays: null,
    channelIds: [],
    headers: {},
    cookies: [],
  };
}

/** Apply a device preset's viewport, unless the operator has already customised it. */
function viewportForPreset(preset: DevicePreset): { width: number; height: number } {
  switch (preset) {
    case 'tablet':
      return { width: 820, height: 1180 };
    case 'mobile':
      return { width: 390, height: 844 };
    default:
      return { width: 1280, height: 800 };
  }
}

export function MonitorForm(props: MonitorFormProps) {
  const {
    initialValues,
    channels,
    submitting,
    submitLabel,
    onSubmit,
    onCancel,
    existingSecrets,
    onPreview,
    previewPending,
    submitError,
  } = props;

  const [values, setValues] = useState<MonitorFormValues>(() => ({
    ...emptyForm(),
    ...(initialValues ?? {}),
  }));
  const [tagDraft, setTagDraft] = useState('');
  const [ignoreDraft, setIgnoreDraft] = useState('');
  const [headerDraft, setHeaderDraft] = useState({ name: '', value: '' });
  const [cookieDraft, setCookieDraft] = useState({ name: '', value: '' });
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const set = <K extends keyof MonitorFormValues>(key: K, value: MonitorFormValues[K]): void => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  /* ------------------------------------------------------- schedule feedback */

  const scheduleError = useMemo(() => {
    if (values.scheduleKind === 'preset') {
      return (INTERVAL_PRESET_KEYS as string[]).includes(values.scheduleValue)
        ? null
        : 'Unknown interval preset';
    }
    if (values.scheduleValue.trim().length === 0) return 'Enter a cron expression';
    if (!isValidCron(values.scheduleValue)) return 'Not a valid 5-field cron expression';
    return null;
  }, [values.scheduleKind, values.scheduleValue]);

  const scheduleDescription = useMemo(() => {
    if (values.scheduleKind === 'preset') {
      const label =
        INTERVAL_PRESET_LABELS[values.scheduleValue as keyof typeof INTERVAL_PRESET_LABELS];
      const cron = presetToCron(values.scheduleValue);
      return label ? `${label} (${cron})` : cron;
    }
    return describeCron(values.scheduleValue);
  }, [values.scheduleKind, values.scheduleValue]);

  /* ------------------------------------------------------------ validation */

  const errors = useMemo(() => {
    const found: Record<string, string> = {};

    if (values.name.trim().length === 0) found['name'] = 'A name is required';
    else if (values.name.length > LIMITS.nameMax)
      found['name'] = `At most ${LIMITS.nameMax} characters`;

    try {
      const parsed = new URL(values.url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        found['url'] = 'Only http and https URLs are allowed';
      }
    } catch {
      found['url'] = 'Enter an absolute URL, including https://';
    }

    if (scheduleError) found['scheduleValue'] = scheduleError;

    if (values.waitStrategy === 'selector' && !values.waitSelector?.trim()) {
      found['waitSelector'] = 'A selector is required for this wait strategy';
    }

    if (values.viewportWidth < LIMITS.viewportMin || values.viewportWidth > LIMITS.viewportMax) {
      found['viewportWidth'] = `Between ${LIMITS.viewportMin} and ${LIMITS.viewportMax}`;
    }
    if (values.viewportHeight < LIMITS.viewportMin || values.viewportHeight > LIMITS.viewportMax) {
      found['viewportHeight'] = `Between ${LIMITS.viewportMin} and ${LIMITS.viewportMax}`;
    }
    if (values.changeThreshold < 0 || values.changeThreshold > 100) {
      found['changeThreshold'] = 'Between 0 and 100';
    }
    if (values.extraDelayMs < 0 || values.extraDelayMs > LIMITS.delayMaxMs) {
      found['extraDelayMs'] = `Between 0 and ${LIMITS.delayMaxMs} ms`;
    }

    return found;
  }, [values, scheduleError]);

  const isValid = Object.keys(errors).length === 0;

  const showError = (key: string): string | undefined => (touched ? errors[key] : undefined);

  /* --------------------------------------------------------------- actions */

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setTouched(true);
    if (!isValid) return;
    onSubmit(normalize(values));
  };

  const runPreview = async (): Promise<void> => {
    setTouched(true);
    setPreview(null);
    setPreviewError(null);
    if (!isValid || !onPreview) return;
    try {
      const result = await onPreview(normalize(values));
      if (result) setPreview(result);
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : String(error));
    }
  };

  /* ------------------------------------------------------------ tag editor */

  const addTag = (): void => {
    const tag = tagDraft.trim();
    if (!tag) return;
    if (values.tags.includes(tag)) {
      setTagDraft('');
      return;
    }
    if (values.tags.length >= LIMITS.tagsMax) return;
    set('tags', [...values.tags, tag]);
    setTagDraft('');
  };

  const addIgnoreSelector = (): void => {
    const selector = ignoreDraft.trim();
    if (!selector) return;
    if (values.ignoreSelectors.includes(selector)) {
      setIgnoreDraft('');
      return;
    }
    set('ignoreSelectors', [...values.ignoreSelectors, selector]);
    setIgnoreDraft('');
  };

  const addHeader = (): void => {
    const name = headerDraft.name.trim();
    if (!name || !headerDraft.value) return;
    set('headers', { ...values.headers, [name]: headerDraft.value });
    setHeaderDraft({ name: '', value: '' });
  };

  const addCookie = (): void => {
    const name = cookieDraft.name.trim();
    if (!name || !cookieDraft.value) return;
    set('cookies', [...values.cookies, { name, value: cookieDraft.value }]);
    setCookieDraft({ name: '', value: '' });
  };

  /* ------------------------------------------------------------------ view */

  return (
    <form className="stack" onSubmit={submit} noValidate>
      {submitError ? <Alert kind="error">{submitError}</Alert> : null}

      <div className="card">
        <div className="card__head">
          <h2>What to watch</h2>
        </div>
        <div className="card__body">
          <div className="form-grid">
            <div className="field">
              <label className="field__label" htmlFor="f-name">
                Name
              </label>
              <input
                id="f-name"
                className="input"
                value={values.name}
                maxLength={LIMITS.nameMax}
                onChange={(event) => set('name', event.target.value)}
                onBlur={() => setTouched(true)}
                aria-invalid={Boolean(showError('name'))}
                aria-describedby={showError('name') ? 'e-name' : undefined}
                placeholder="Acme pricing page"
                required
              />
              {showError('name') ? (
                <span className="field__error" id="e-name">
                  {showError('name')}
                </span>
              ) : (
                <span className="field__hint">Shown on the dashboard and in notifications.</span>
              )}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="f-url">
                URL
              </label>
              <input
                id="f-url"
                className="input input--mono"
                type="url"
                value={values.url}
                maxLength={LIMITS.urlMax}
                onChange={(event) => set('url', event.target.value)}
                onBlur={() => setTouched(true)}
                aria-invalid={Boolean(showError('url'))}
                aria-describedby={showError('url') ? 'e-url' : 'h-url'}
                placeholder="https://example.com/pricing"
                required
              />
              {showError('url') ? (
                <span className="field__error" id="e-url">
                  {showError('url')}
                </span>
              ) : (
                <span className="field__hint" id="h-url">
                  http and https only. Internal addresses are blocked unless the server allows them.
                </span>
              )}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="f-tag">
                Tags
              </label>
              <div className="row" style={{ gap: 6 }}>
                <input
                  id="f-tag"
                  className="input"
                  value={tagDraft}
                  maxLength={LIMITS.tagMax}
                  onChange={(event) => setTagDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addTag();
                    }
                  }}
                  placeholder="Add a tag and press Enter"
                />
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={addTag}
                  disabled={!tagDraft.trim()}
                >
                  Add
                </button>
              </div>
              {values.tags.length > 0 ? (
                <div className="row" style={{ gap: 4, marginTop: 6 }}>
                  {values.tags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className="tag"
                      onClick={() =>
                        set(
                          'tags',
                          values.tags.filter((item) => item !== tag),
                        )
                      }
                      title={`Remove tag ${tag}`}
                      aria-label={`Remove tag ${tag}`}
                    >
                      {tag} ×
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card__head">
          <h2>Schedule</h2>
        </div>
        <div className="card__body">
          <div className="form-grid">
            <div className="field">
              <span className="field__label" id="f-schedule-label">
                How often
              </span>
              <div
                className="row"
                role="radiogroup"
                aria-labelledby="f-schedule-label"
                style={{ gap: 6 }}
              >
                <label className="checkbox">
                  <input
                    type="radio"
                    name="scheduleKind"
                    value="preset"
                    checked={values.scheduleKind === 'preset'}
                    onChange={() =>
                      setValues((current) => ({
                        ...current,
                        scheduleKind: 'preset',
                        scheduleValue: '24h',
                      }))
                    }
                  />
                  Preset interval
                </label>
                <label className="checkbox">
                  <input
                    type="radio"
                    name="scheduleKind"
                    value="cron"
                    checked={values.scheduleKind === 'cron'}
                    onChange={() =>
                      setValues((current) => ({
                        ...current,
                        scheduleKind: 'cron',
                        scheduleValue: '0 6 * * *',
                      }))
                    }
                  />
                  Cron expression
                </label>
              </div>
            </div>

            {values.scheduleKind === 'preset' ? (
              <div className="field">
                <label className="field__label" htmlFor="f-preset">
                  Interval
                </label>
                <select
                  id="f-preset"
                  className="select"
                  value={values.scheduleValue}
                  onChange={(event) => set('scheduleValue', event.target.value)}
                >
                  {INTERVAL_PRESET_KEYS.map((preset) => (
                    <option key={preset} value={preset}>
                      {INTERVAL_PRESET_LABELS[preset]}
                    </option>
                  ))}
                </select>
                <span className="field__hint">{scheduleDescription}</span>
              </div>
            ) : (
              <div className="field">
                <label className="field__label" htmlFor="f-cron">
                  Cron (minute hour day month weekday, UTC)
                </label>
                <input
                  id="f-cron"
                  className="input input--mono"
                  value={values.scheduleValue}
                  onChange={(event) => set('scheduleValue', event.target.value)}
                  onBlur={() => setTouched(true)}
                  aria-invalid={Boolean(showError('scheduleValue'))}
                  aria-describedby={showError('scheduleValue') ? 'e-cron' : 'h-cron'}
                  placeholder="30 6 * * 1-5"
                />
                {showError('scheduleValue') ? (
                  <span className="field__error" id="e-cron">
                    {showError('scheduleValue')}
                  </span>
                ) : (
                  <span className="field__hint" id="h-cron">
                    {scheduleDescription}
                  </span>
                )}
              </div>
            )}

            <div className="field">
              <label className="field__label" htmlFor="f-threshold">
                Change threshold (%)
              </label>
              <input
                id="f-threshold"
                className="input"
                type="number"
                min={0}
                max={100}
                step={0.05}
                value={values.changeThreshold}
                onChange={(event) =>
                  set('changeThreshold', Number.parseFloat(event.target.value) || 0)
                }
                aria-describedby="h-threshold"
              />
              <span className="field__hint" id="h-threshold">
                Pixel differences at or above this percentage count as significant. Text and HTML
                changes are always significant when detection is on.
              </span>
            </div>
          </div>

          <div className="form-section">
            <div className="form-section__title">Change detection</div>
            <div className="row" style={{ gap: 18 }}>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={values.detectText}
                  onChange={(event) => set('detectText', event.target.checked)}
                />
                Compare visible text
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={values.detectHtml}
                  onChange={(event) => set('detectHtml', event.target.checked)}
                />
                Compare normalised HTML
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={values.enabled}
                  onChange={(event) => set('enabled', event.target.checked)}
                />
                Enabled (runs on schedule)
              </label>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card__head">
          <h2>Capture</h2>
        </div>
        <div className="card__body">
          <div className="form-grid">
            <div className="field">
              <label className="field__label" htmlFor="f-device">
                Device preset
              </label>
              <select
                id="f-device"
                className="select"
                value={values.devicePreset}
                onChange={(event) => {
                  const preset = event.target.value as DevicePreset;
                  const viewport = viewportForPreset(preset);
                  setValues((current) => ({
                    ...current,
                    devicePreset: preset,
                    viewportWidth: viewport.width,
                    viewportHeight: viewport.height,
                  }));
                }}
              >
                {DEVICE_PRESET_KEYS.map((preset) => (
                  <option key={preset} value={preset}>
                    {DEVICE_LABELS[preset]}
                  </option>
                ))}
              </select>
              <span className="field__hint">
                Sets the viewport, scale factor and touch emulation.
              </span>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="f-width">
                Viewport width
              </label>
              <input
                id="f-width"
                className="input"
                type="number"
                min={LIMITS.viewportMin}
                max={LIMITS.viewportMax}
                value={values.viewportWidth}
                onChange={(event) =>
                  set('viewportWidth', Number.parseInt(event.target.value, 10) || 0)
                }
                aria-invalid={Boolean(showError('viewportWidth'))}
              />
              {showError('viewportWidth') ? (
                <span className="field__error">{showError('viewportWidth')}</span>
              ) : null}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="f-height">
                Viewport height
              </label>
              <input
                id="f-height"
                className="input"
                type="number"
                min={LIMITS.viewportMin}
                max={LIMITS.viewportMax}
                value={values.viewportHeight}
                onChange={(event) =>
                  set('viewportHeight', Number.parseInt(event.target.value, 10) || 0)
                }
                aria-invalid={Boolean(showError('viewportHeight'))}
              />
              {showError('viewportHeight') ? (
                <span className="field__error">{showError('viewportHeight')}</span>
              ) : null}
            </div>

            <div className="field">
              <span className="field__label">Screenshot</span>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={values.fullPage}
                  onChange={(event) => set('fullPage', event.target.checked)}
                />
                Capture the full page, not just the viewport
              </label>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="f-wait">
                Wait strategy
              </label>
              <select
                id="f-wait"
                className="select"
                value={values.waitStrategy}
                onChange={(event) => set('waitStrategy', event.target.value as WaitStrategy)}
                aria-describedby="h-wait"
              >
                {WAIT_STRATEGIES.map((strategy) => (
                  <option key={strategy} value={strategy}>
                    {WAIT_LABELS[strategy]}
                  </option>
                ))}
              </select>
              <span className="field__hint" id="h-wait">
                Network idle is best for single-page apps but can hang on pages that poll.
              </span>
            </div>

            {values.waitStrategy === 'selector' ? (
              <div className="field">
                <label className="field__label" htmlFor="f-wait-selector">
                  Wait for selector
                </label>
                <input
                  id="f-wait-selector"
                  className="input input--mono"
                  value={values.waitSelector ?? ''}
                  onChange={(event) => set('waitSelector', event.target.value || null)}
                  onBlur={() => setTouched(true)}
                  aria-invalid={Boolean(showError('waitSelector'))}
                  placeholder="#app.loaded"
                />
                {showError('waitSelector') ? (
                  <span className="field__error">{showError('waitSelector')}</span>
                ) : (
                  <span className="field__hint">
                    The capture waits until this element is visible.
                  </span>
                )}
              </div>
            ) : null}

            <div className="field">
              <label className="field__label" htmlFor="f-delay">
                Extra delay (ms)
              </label>
              <input
                id="f-delay"
                className="input"
                type="number"
                min={0}
                max={LIMITS.delayMaxMs}
                step={100}
                value={values.extraDelayMs}
                onChange={(event) =>
                  set('extraDelayMs', Number.parseInt(event.target.value, 10) || 0)
                }
                aria-describedby="h-delay"
              />
              <span className="field__hint" id="h-delay">
                Wait this long after the page settles, before the screenshot.
              </span>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="f-capture-selector">
                Capture only this element (optional)
              </label>
              <input
                id="f-capture-selector"
                className="input input--mono"
                value={values.captureSelector ?? ''}
                onChange={(event) => set('captureSelector', event.target.value || null)}
                placeholder="#pricing-table"
                aria-describedby="h-capture-selector"
              />
              <span className="field__hint" id="h-capture-selector">
                Screenshot, text and HTML are taken from this element only. Useful for one component
                on a busy page.
              </span>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="f-user-agent">
                Custom User-Agent (optional)
              </label>
              <input
                id="f-user-agent"
                className="input input--mono"
                value={values.userAgent ?? ''}
                onChange={(event) => set('userAgent', event.target.value || null)}
                placeholder="Pagefreeze/0.1.0 (+https://example.org/bot)"
                aria-describedby="h-user-agent"
              />
              <span className="field__hint" id="h-user-agent">
                Leave blank to identify as Pagefreeze, which is the polite default.
              </span>
            </div>
          </div>

          <div className="form-section">
            <div className="form-section__title">Ignore before capture</div>
            <div className="field">
              <label className="field__label" htmlFor="f-ignore">
                Hide these selectors
              </label>
              <div className="row" style={{ gap: 6 }}>
                <input
                  id="f-ignore"
                  className="input input--mono"
                  value={ignoreDraft}
                  onChange={(event) => setIgnoreDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addIgnoreSelector();
                    }
                  }}
                  placeholder=".cookie-banner, #timestamp"
                />
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={addIgnoreSelector}
                  disabled={!ignoreDraft.trim()}
                >
                  Add
                </button>
              </div>
              <span className="field__hint">
                Elements are hidden before the screenshot and before text and HTML are extracted, so
                volatile content like timestamps, ads and cookie banners does not create false
                changes.
              </span>
              {values.ignoreSelectors.length > 0 ? (
                <ul className="list-plain row" style={{ gap: 4, marginTop: 6 }}>
                  {values.ignoreSelectors.map((selector) => (
                    <li key={selector}>
                      <button
                        type="button"
                        className="tag"
                        onClick={() =>
                          set(
                            'ignoreSelectors',
                            values.ignoreSelectors.filter((item) => item !== selector),
                          )
                        }
                        aria-label={`Stop ignoring ${selector}`}
                        title={`Stop ignoring ${selector}`}
                      >
                        <code>{selector}</code> ×
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card__head">
          <h2>Authentication for the target page</h2>
        </div>
        <div className="card__body">
          <Alert kind="info">
            Values are encrypted at rest with AES-256-GCM and are never returned by the API after
            they are saved — only the names are. Only basic header and cookie authentication is
            supported; interactive login flows are not.
          </Alert>

          <div className="form-grid" style={{ marginTop: 14 }}>
            <div className="field">
              <span className="field__label">Custom request headers</span>
              {existingSecrets && existingSecrets.headerNames.length > 0 ? (
                <div className="row" style={{ gap: 4 }}>
                  {existingSecrets.headerNames.map((name) => (
                    <span key={name} className="tag" title="Stored; value hidden">
                      <code>{name}</code>
                    </span>
                  ))}
                </div>
              ) : null}
              {Object.keys(values.headers).length > 0 ? (
                <ul className="list-plain stack" style={{ gap: 4 }}>
                  {Object.entries(values.headers).map(([name, value]) => (
                    <li key={name} className="row" style={{ gap: 6 }}>
                      <code className="grow">{name}</code>
                      <span className="faint small" title="Value is hidden">
                        {'•'.repeat(Math.min(12, Math.max(4, value.length)))}
                      </span>
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost"
                        onClick={() => {
                          const next = { ...values.headers };
                          delete next[name];
                          set('headers', next);
                        }}
                        aria-label={`Remove header ${name}`}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="row" style={{ gap: 6 }}>
                <input
                  className="input input--mono"
                  aria-label="Header name"
                  placeholder="Authorization"
                  value={headerDraft.name}
                  onChange={(event) => setHeaderDraft({ ...headerDraft, name: event.target.value })}
                />
                <input
                  className="input input--mono"
                  aria-label="Header value"
                  type="password"
                  placeholder="Bearer …"
                  value={headerDraft.value}
                  onChange={(event) =>
                    setHeaderDraft({ ...headerDraft, value: event.target.value })
                  }
                />
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={addHeader}
                  disabled={!headerDraft.name.trim() || !headerDraft.value}
                >
                  Add
                </button>
              </div>
            </div>

            <div className="field">
              <span className="field__label">Cookies</span>
              {existingSecrets && existingSecrets.cookieNames.length > 0 ? (
                <div className="row" style={{ gap: 4 }}>
                  {existingSecrets.cookieNames.map((name) => (
                    <span key={name} className="tag" title="Stored; value hidden">
                      <code>{name}</code>
                    </span>
                  ))}
                </div>
              ) : null}
              {values.cookies.length > 0 ? (
                <ul className="list-plain stack" style={{ gap: 4 }}>
                  {values.cookies.map((cookie) => (
                    <li key={cookie.name} className="row" style={{ gap: 6 }}>
                      <code className="grow">{cookie.name}</code>
                      <span className="faint small" title="Value is hidden">
                        {'•'.repeat(Math.min(12, Math.max(4, cookie.value.length)))}
                      </span>
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost"
                        onClick={() =>
                          set(
                            'cookies',
                            values.cookies.filter((item) => item.name !== cookie.name),
                          )
                        }
                        aria-label={`Remove cookie ${cookie.name}`}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="row" style={{ gap: 6 }}>
                <input
                  className="input input--mono"
                  aria-label="Cookie name"
                  placeholder="session"
                  value={cookieDraft.name}
                  onChange={(event) => setCookieDraft({ ...cookieDraft, name: event.target.value })}
                />
                <input
                  className="input input--mono"
                  aria-label="Cookie value"
                  type="password"
                  placeholder="value"
                  value={cookieDraft.value}
                  onChange={(event) =>
                    setCookieDraft({ ...cookieDraft, value: event.target.value })
                  }
                />
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={addCookie}
                  disabled={!cookieDraft.name.trim() || !cookieDraft.value}
                >
                  Add
                </button>
              </div>
              <span className="field__hint">Cookies are scoped to the monitored URL's domain.</span>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card__head">
          <h2>Notifications &amp; retention</h2>
        </div>
        <div className="card__body">
          <div className="form-grid">
            <div className="field">
              <span className="field__label" id="f-channels-label">
                Notify these channels
              </span>
              {channels.length === 0 ? (
                <span className="field__hint">
                  No channels yet. Create one in Settings, then attach it here.
                </span>
              ) : (
                <div
                  className="stack"
                  role="group"
                  aria-labelledby="f-channels-label"
                  style={{ gap: 6 }}
                >
                  {channels.map((channel) => (
                    <label className="checkbox" key={channel.id}>
                      <input
                        type="checkbox"
                        checked={values.channelIds.includes(channel.id)}
                        onChange={(event) =>
                          set(
                            'channelIds',
                            event.target.checked
                              ? [...values.channelIds, channel.id]
                              : values.channelIds.filter((id) => id !== channel.id),
                          )
                        }
                      />
                      {channel.name}{' '}
                      <span className="faint">
                        ({channel.type}
                        {channel.enabled ? '' : ', disabled'})
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="f-retention">
                Retention (days)
              </label>
              <input
                id="f-retention"
                className="input"
                type="number"
                min={1}
                max={3650}
                placeholder="Use the global default"
                value={values.retentionDays ?? ''}
                onChange={(event) =>
                  set(
                    'retentionDays',
                    event.target.value === '' ? null : Number.parseInt(event.target.value, 10),
                  )
                }
                aria-describedby="h-retention"
              />
              <span className="field__hint" id="h-retention">
                Snapshots and changes older than this are deleted. The newest snapshot is always
                kept. Blank uses the server default.
              </span>
            </div>
          </div>
        </div>
      </div>

      {onPreview ? (
        <div className="card">
          <div className="card__head">
            <h3>Test capture</h3>
            <div className="grow" />
            <button
              type="button"
              className="btn"
              onClick={() => void runPreview()}
              disabled={previewPending || !isValid}
              title={
                isValid ? 'Capture the page once, without saving' : 'Fix the errors above first'
              }
            >
              {previewPending ? <Spinner label="Capturing" /> : <IconCamera size={14} />}
              {previewPending ? 'Capturing…' : 'Test capture now'}
            </button>
          </div>
          <div className="card__body">
            {previewError ? <Alert kind="error">{previewError}</Alert> : null}
            {preview ? <PreviewPanel result={preview} /> : null}
            {!preview && !previewError ? (
              <p className="small muted" style={{ margin: 0 }}>
                Runs the real capture pipeline once against this URL without saving anything, so you
                can check the viewport, wait strategy and ignore selectors before you commit to a
                schedule.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="form-actions">
        <button
          type="submit"
          className="btn btn--primary"
          disabled={submitting || (touched && !isValid)}
        >
          {submitting ? <Spinner label="Saving" /> : null}
          {submitLabel}
        </button>
        {onCancel ? (
          <button type="button" className="btn" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
        ) : null}
        {!isValid && touched ? (
          <span className="small" style={{ color: 'var(--failing)' }}>
            {Object.keys(errors).length} field{Object.keys(errors).length === 1 ? '' : 's'} need
            attention
          </span>
        ) : null}
      </div>
    </form>
  );
}

function PreviewPanel({ result }: { result: PreviewResult }) {
  if (!result.ok) {
    return (
      <Alert kind="error">
        Preview capture failed: {result.error ?? 'unknown error'}
        {result.blockedRequests.length > 0 ? (
          <div className="small" style={{ marginTop: 6 }}>
            {result.blockedRequests.length} request(s) blocked by the SSRF guard, e.g.{' '}
            <code>{result.blockedRequests[0]?.reason}</code>
          </div>
        ) : null}
      </Alert>
    );
  }

  return (
    <div className="stack">
      <div className="row" style={{ gap: 18 }}>
        <Stat label="Status" value={result.httpStatus !== null ? String(result.httpStatus) : '—'} />
        <Stat label="Load time" value={durationLabel(result.loadDurationMs)} />
        <Stat
          label="Size"
          value={result.width && result.height ? `${result.width}×${result.height}` : '—'}
        />
        <Stat label="Screenshot" value={bytesLabel(result.bytes)} />
      </div>

      {result.title ? (
        <div className="small muted">
          Page title: <strong>{result.title}</strong>
        </div>
      ) : null}

      {result.finalUrl && result.finalUrl !== undefined ? (
        <div className="small faint">
          Final URL: <code>{result.finalUrl}</code>
        </div>
      ) : null}

      {result.blockedRequests.length > 0 ? (
        <Alert kind="warn">
          {result.blockedRequests.length} subrequest(s) were blocked by the SSRF guard or the
          resource filter.
          <details style={{ marginTop: 6 }}>
            <summary className="small" style={{ cursor: 'pointer' }}>
              Which ones
            </summary>
            <ul className="list-plain stack" style={{ gap: 2, marginTop: 6 }}>
              {result.blockedRequests.slice(0, 20).map((blocked, index) => (
                <li key={`${blocked.url}-${index}`} className="small">
                  <code>{blocked.reason}</code> <span className="faint">{blocked.url}</span>
                </li>
              ))}
            </ul>
          </details>
        </Alert>
      ) : null}

      {result.screenshotBase64 ? (
        <div>
          <div className="small muted" style={{ marginBottom: 6 }}>
            Preview screenshot
          </div>
          <img
            src={`data:image/png;base64,${result.screenshotBase64}`}
            alt="Preview of the captured page"
            style={{
              maxWidth: '100%',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              background: '#fff',
            }}
          />
        </div>
      ) : (
        <Alert kind="warn">
          The screenshot was too large to return inline ({bytesLabel(result.bytes)}). The capture
          itself succeeded.
        </Alert>
      )}

      {result.textPreview ? (
        <details>
          <summary className="small muted" style={{ cursor: 'pointer' }}>
            Extracted text (first {result.textPreview.length} characters)
          </summary>
          <pre
            className="diff"
            style={{
              whiteSpace: 'pre-wrap',
              background: 'var(--bg-sunken)',
              padding: 10,
              borderRadius: 'var(--radius-sm)',
              marginTop: 8,
              maxHeight: 220,
              overflow: 'auto',
            }}
          >
            {result.textPreview}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value" style={{ fontSize: 15 }}>
        {value}
      </span>
    </div>
  );
}

/**
 * Coerce the form state into exactly what the API expects: empty strings become null for
 * nullable fields, and numeric strings become numbers.
 */
function normalize(values: MonitorFormValues): MonitorFormValues {
  return {
    ...values,
    name: values.name.trim(),
    url: values.url.trim(),
    waitSelector: values.waitSelector?.trim() ? values.waitSelector.trim() : null,
    captureSelector: values.captureSelector?.trim() ? values.captureSelector.trim() : null,
    userAgent: values.userAgent?.trim() ? values.userAgent.trim() : null,
    tags: values.tags.map((tag) => tag.trim()).filter(Boolean),
    ignoreSelectors: values.ignoreSelectors.map((item) => item.trim()).filter(Boolean),
  };
}
