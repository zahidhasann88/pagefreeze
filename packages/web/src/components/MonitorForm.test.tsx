import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MonitorForm } from '../components/MonitorForm.js';
import type { MonitorFormValues, NotificationChannel, PreviewResult } from '../api/types.js';

const channels: NotificationChannel[] = [
  {
    id: 'channel-1',
    name: 'Ops webhook',
    type: 'webhook',
    enabled: true,
    config: { url: 'https://example.com/hook', hasSecret: true },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'channel-2',
    name: 'Slack',
    type: 'slack',
    enabled: false,
    config: { url: 'https://hooks.slack.com/x' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

function renderForm(props: Partial<Parameters<typeof MonitorForm>[0]> = {}) {
  const onSubmit = vi.fn();
  const onPreview = vi.fn();
  const utils = render(
    <MonitorForm
      channels={channels}
      submitting={false}
      submitLabel="Create monitor"
      onSubmit={onSubmit}
      onPreview={onPreview}
      {...props}
    />,
  );
  return { ...utils, onSubmit, onPreview };
}

function addButton(labelText: RegExp): HTMLElement {
  const input = screen.getByLabelText(labelText);
  const row = input.closest('.row') as HTMLElement;
  return within(row).getByRole('button', { name: /^add$/i });
}

async function fillRequiredFields(name = 'Acme pricing', url = 'https://example.com/pricing') {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/^name$/i), name);
  await user.type(screen.getByLabelText(/^url$/i), url);
}

describe('MonitorForm defaults', () => {
  it('starts empty with the documented capture defaults', () => {
    renderForm();

    expect(screen.getByLabelText(/^name$/i)).toHaveValue('');
    expect(screen.getByLabelText(/^url$/i)).toHaveValue('');
    expect(screen.getByLabelText(/^viewport width$/i)).toHaveValue(1280);
    expect(screen.getByLabelText(/^viewport height$/i)).toHaveValue(800);
    expect(screen.getByLabelText(/^change threshold/i)).toHaveValue(0.5);
    expect(screen.getByLabelText(/full page/i)).toBeChecked();
    expect(screen.getByLabelText(/compare visible text/i)).toBeChecked();
    expect(screen.getByLabelText(/compare normalised html/i)).toBeChecked();
    expect(screen.getByLabelText(/enabled \(runs on schedule\)/i)).toBeChecked();
  });

  it('pre-fills from initialValues when editing', () => {
    renderForm({
      initialValues: {
        name: 'Existing',
        url: 'https://example.com/terms',
        changeThreshold: 2,
        ignoreSelectors: ['#clock'],
        tags: ['legal'],
        scheduleKind: 'cron',
        scheduleValue: '0 6 * * *',
      } as Partial<MonitorFormValues>,
    });

    expect(screen.getByLabelText(/^name$/i)).toHaveValue('Existing');
    expect(screen.getByLabelText(/^change threshold/i)).toHaveValue(2);
    expect(screen.getByLabelText(/^cron \(minute hour/i)).toHaveValue('0 6 * * *');
    expect(screen.getByTitle('Remove tag legal')).toBeInTheDocument();
    expect(screen.getByTitle('Stop ignoring #clock')).toBeInTheDocument();
  });

  it('shows stored secret names but never values', () => {
    renderForm({
      initialValues: { name: 'x', url: 'https://e.com' } as Partial<MonitorFormValues>,
      existingSecrets: { headerNames: ['Authorization'], cookieNames: ['sid'] },
    });

    expect(screen.getAllByTitle('Stored; value hidden')).toHaveLength(2);
    expect(screen.getByText('Authorization')).toBeInTheDocument();
    expect(screen.getByText('sid')).toBeInTheDocument();
  });
});

describe('MonitorForm validation', () => {
  it('blocks submit and names the offending fields when required input is missing', async () => {
    const { onSubmit } = renderForm();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /create monitor/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByText(/a name is required/i)).toBeInTheDocument();
    expect(screen.getByText(/enter an absolute url/i)).toBeInTheDocument();
    expect(screen.getByText(/1 field|2 fields|fields need attention/i)).toBeInTheDocument();
  });

  it('rejects a non-http URL scheme', async () => {
    const { onSubmit } = renderForm();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/^name$/i), 'Bad scheme');
    await user.type(screen.getByLabelText(/^url$/i), 'file:///etc/passwd');
    await user.click(screen.getByRole('button', { name: /create monitor/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByText(/only http and https/i)).toBeInTheDocument();

    expect(screen.getByLabelText(/^url$/i)).toHaveAttribute('aria-invalid', 'true');
  });

  it('accepts a valid http URL', async () => {
    const { onSubmit } = renderForm();
    await fillRequiredFields('Local', 'http://127.0.0.1:8090/pricing');
    await userEvent.click(screen.getByRole('button', { name: /create monitor/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      name: 'Local',
      url: 'http://127.0.0.1:8090/pricing',
    });
  });

  it('requires a selector when the wait strategy is selector', async () => {
    const { onSubmit } = renderForm();
    const user = userEvent.setup();
    await fillRequiredFields();

    await user.selectOptions(screen.getByLabelText(/^wait strategy$/i), 'selector');
    expect(await screen.findByLabelText(/wait for selector/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /create monitor/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/selector is required for this wait strategy/i),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText(/wait for selector/i), '#app.ready');
    await user.click(screen.getByRole('button', { name: /create monitor/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      waitStrategy: 'selector',
      waitSelector: '#app.ready',
    });
  });

  it('hides the selector field again for other strategies', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.selectOptions(screen.getByLabelText(/^wait strategy$/i), 'selector');
    expect(await screen.findByLabelText(/wait for selector/i)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/^wait strategy$/i), 'load');
    expect(screen.queryByLabelText(/wait for selector/i)).not.toBeInTheDocument();
  });

  it('rejects out-of-range numbers', async () => {
    const { onSubmit } = renderForm();
    const user = userEvent.setup();
    await fillRequiredFields();

    const width = screen.getByLabelText(/^viewport width$/i);
    await user.clear(width);
    await user.type(width, '10');

    await user.click(screen.getByRole('button', { name: /create monitor/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByText(/between 200 and 8000/i)).toBeInTheDocument();
  });
});

describe('MonitorForm schedule', () => {
  it('describes a preset interval in plain language', () => {
    renderForm();

    expect(screen.getByText(/^every day \(0 0 \* \* \*\)$/i)).toBeInTheDocument();

    const preset = screen.getByLabelText(/^interval$/i);
    expect(preset).toHaveValue('24h');
  });

  it('lists every preset', () => {
    renderForm();
    const options = within(screen.getByLabelText(/^interval$/i)).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'Every 15 minutes',
      'Every hour',
      'Every 6 hours',
      'Every day',
      'Every week',
    ]);
  });

  it('describes a cron expression in human terms', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('radio', { name: /cron expression/i }));
    const cron = await screen.findByLabelText(/^cron \(minute hour/i);
    expect(cron).toHaveValue('0 6 * * *');
    expect(screen.getByText(/at 06:00 utc every day/i)).toBeInTheDocument();

    await user.clear(cron);
    await user.type(cron, '30 9 * * 1-5');
    expect(await screen.findByText(/monday through friday/i)).toBeInTheDocument();
    expect(screen.getByText(/09:30 utc/i)).toBeInTheDocument();
  });

  it('flags an invalid cron expression as you type', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await fillRequiredFields();

    await user.click(screen.getByRole('radio', { name: /cron expression/i }));
    const cron = await screen.findByLabelText(/^cron \(minute hour/i);
    await user.clear(cron);
    await user.type(cron, 'every morning');
    await user.tab();

    expect(await screen.findByText(/not a valid 5-field cron expression/i)).toBeInTheDocument();
    expect(cron).toHaveAttribute('aria-invalid', 'true');

    await user.click(screen.getByRole('button', { name: /create monitor/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('explains a cron with the wrong number of fields', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole('radio', { name: /cron expression/i }));
    const cron = await screen.findByLabelText(/^cron \(minute hour/i);
    await user.clear(cron);
    await user.type(cron, '* * *');
    await user.tab();

    expect(await screen.findByText(/not a valid 5-field cron expression/i)).toBeInTheDocument();
  });

  it('switching to cron supplies a valid starting expression', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole('radio', { name: /cron expression/i }));
    const cron = await screen.findByLabelText(/^cron \(minute hour/i);

    expect(cron).toHaveValue('0 6 * * *');
    expect(screen.queryByText(/not a valid/i)).not.toBeInTheDocument();
  });
});

describe('MonitorForm list editors', () => {
  it('adds and removes tags, and de-duplicates', async () => {
    const user = userEvent.setup();
    renderForm();

    const tagInput = screen.getByLabelText(/^tags$/i);
    await user.type(tagInput, 'pricing');
    await user.keyboard('{Enter}');
    expect(screen.getByTitle('Remove tag pricing')).toBeInTheDocument();

    await user.type(tagInput, 'pricing');
    await user.keyboard('{Enter}');

    expect(screen.getAllByTitle('Remove tag pricing')).toHaveLength(1);

    await user.click(screen.getByTitle('Remove tag pricing'));
    expect(screen.queryByTitle('Remove tag pricing')).not.toBeInTheDocument();
  });

  it('adds and removes ignore selectors', async () => {
    const user = userEvent.setup();
    renderForm();

    const input = screen.getByLabelText(/hide these selectors/i);
    await user.type(input, '.cookie-banner');
    await user.click(addButton(/hide these selectors/i));

    expect(screen.getByTitle('Stop ignoring .cookie-banner')).toBeInTheDocument();
    expect(input).toHaveValue('');

    await user.click(screen.getByTitle('Stop ignoring .cookie-banner'));
    expect(screen.queryByTitle('Stop ignoring .cookie-banner')).not.toBeInTheDocument();
  });

  it('explains why ignore selectors exist', () => {
    renderForm();
    expect(screen.getByText(/volatile content like timestamps/i)).toBeInTheDocument();
  });

  it('collects custom headers and hides their values', async () => {
    const { onSubmit } = renderForm();
    const user = userEvent.setup();
    await fillRequiredFields();

    await user.type(screen.getByLabelText(/^header name$/i), 'Authorization');
    await user.type(screen.getByLabelText(/^header value$/i), 'Bearer abc123');
    await user.click(addButton(/^header value$/i));

    expect(screen.getByText('Authorization')).toBeInTheDocument();

    expect(screen.queryByText('Bearer abc123')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /create monitor/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]?.headers).toEqual({ Authorization: 'Bearer abc123' });
  });

  it('collects cookies', async () => {
    const { onSubmit } = renderForm();
    const user = userEvent.setup();
    await fillRequiredFields();

    await user.type(screen.getByLabelText(/^cookie name$/i), 'sid');
    await user.type(screen.getByLabelText(/^cookie value$/i), 'secret-value');
    await user.click(addButton(/^cookie value$/i));

    expect(screen.getByText('sid')).toBeInTheDocument();
    expect(screen.queryByText('secret-value')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /create monitor/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]?.cookies).toEqual([{ name: 'sid', value: 'secret-value' }]);
  });

  it('attaches and detaches notification channels', async () => {
    const { onSubmit } = renderForm();
    const user = userEvent.setup();
    await fillRequiredFields();

    const ops = screen.getByRole('checkbox', { name: /ops webhook/i });
    expect(ops).not.toBeChecked();
    await user.click(ops);
    expect(ops).toBeChecked();

    await user.click(screen.getByRole('button', { name: /create monitor/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]?.channelIds).toEqual(['channel-1']);
  });

  it('shows a disabled channel as disabled', () => {
    renderForm();
    const slack = screen.getByRole('checkbox', { name: /slack/i });
    expect(slack.closest('label')?.textContent).toContain('(slack, disabled)');
  });

  it('points to Settings when there are no channels', () => {
    renderForm({ channels: [] });
    expect(screen.getByText(/no channels yet/i)).toBeInTheDocument();
    expect(screen.getByText(/create one in settings/i)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /ops webhook/i })).not.toBeInTheDocument();
  });
});

describe('MonitorForm device presets', () => {
  it('applies the preset viewport when the device changes', async () => {
    const user = userEvent.setup();
    renderForm();

    expect(screen.getByLabelText(/^viewport width$/i)).toHaveValue(1280);

    await user.selectOptions(screen.getByLabelText(/^device preset$/i), 'mobile');
    expect(screen.getByLabelText(/^viewport width$/i)).toHaveValue(390);
    expect(screen.getByLabelText(/^viewport height$/i)).toHaveValue(844);

    await user.selectOptions(screen.getByLabelText(/^device preset$/i), 'tablet');
    expect(screen.getByLabelText(/^viewport width$/i)).toHaveValue(820);

    await user.selectOptions(screen.getByLabelText(/^device preset$/i), 'desktop');
    expect(screen.getByLabelText(/^viewport width$/i)).toHaveValue(1280);
    expect(screen.getByLabelText(/^viewport height$/i)).toHaveValue(800);
  });

  it('still lets the operator override the preset viewport', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await fillRequiredFields();

    await user.selectOptions(screen.getByLabelText(/^device preset$/i), 'mobile');
    const width = screen.getByLabelText(/^viewport width$/i);
    await user.clear(width);
    await user.type(width, '420');

    await user.click(screen.getByRole('button', { name: /create monitor/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      devicePreset: 'mobile',
      viewportWidth: 420,
    });
  });
});

describe('MonitorForm submission payload', () => {
  it('trims text and turns empty optional fields into null', async () => {
    const { onSubmit } = renderForm();
    const user = userEvent.setup();
    await fillRequiredFields('  Padded name  ', '  https://example.com/x  ');

    await user.type(screen.getByLabelText(/custom user-agent/i), '   ');
    await user.type(screen.getByLabelText(/capture only this element/i), '   ');

    await user.click(screen.getByRole('button', { name: /create monitor/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      name: 'Padded name',
      url: 'https://example.com/x',
      userAgent: null,
      captureSelector: null,
      waitSelector: null,
    });
  });

  it('carries every documented capture setting', async () => {
    const { onSubmit } = renderForm();
    const user = userEvent.setup();
    await fillRequiredFields();

    await user.clear(screen.getByLabelText(/extra delay/i));
    await user.type(screen.getByLabelText(/extra delay/i), '500');
    await user.clear(screen.getByLabelText(/^change threshold/i));
    await user.type(screen.getByLabelText(/^change threshold/i), '1.25');
    await user.type(screen.getByLabelText(/custom user-agent/i), 'MyBot/1.0');
    await user.click(screen.getByLabelText(/full page/i));
    await user.click(screen.getByLabelText(/compare visible text/i));
    await user.type(screen.getByLabelText(/^retention \(days\)$/i), '30');

    await user.click(screen.getByRole('button', { name: /create monitor/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      extraDelayMs: 500,
      changeThreshold: 1.25,
      userAgent: 'MyBot/1.0',
      fullPage: false,
      detectText: false,
      detectHtml: true,
      retentionDays: 30,
    });
  });

  it('sends a null retention when the field is cleared', async () => {
    const { onSubmit } = renderForm();
    const user = userEvent.setup();
    await fillRequiredFields();

    const retention = screen.getByLabelText(/^retention \(days\)$/i);
    await user.type(retention, '14');
    await user.clear(retention);

    await user.click(screen.getByRole('button', { name: /create monitor/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]?.retentionDays).toBeNull();
  });

  it('disables the submit button while saving and shows progress', () => {
    renderForm({ submitting: true });
    const button = screen.getByRole('button', { name: /create monitor/i });
    expect(button).toBeDisabled();
    expect(screen.getByRole('status', { name: /saving/i })).toBeInTheDocument();
  });

  it('surfaces a server-side error', () => {
    renderForm({ submitError: 'URL is not allowed by the SSRF policy: loopback' });
    expect(screen.getByRole('alert')).toHaveTextContent(/SSRF policy/i);
  });

  it('cancels when asked', async () => {
    const onCancel = vi.fn();
    renderForm({ onCancel });
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('MonitorForm test capture', () => {
  const previewResult: PreviewResult = {
    ok: true,
    error: null,
    title: 'Acme Pricing',
    finalUrl: 'https://example.com/pricing',
    httpStatus: 200,
    loadDurationMs: 1234,
    width: 1280,
    height: 900,
    bytes: 45_000,
    screenshotBase64: 'iVBORw0KGgo=',
    textPreview: 'Acme Cloud Pricing\nSimple, per-seat pricing.',
    blockedRequests: [],
  };

  it('runs a preview and shows the resulting screenshot and metadata', async () => {
    const onPreview = vi.fn().mockResolvedValue(previewResult);
    renderForm({ onPreview });
    await fillRequiredFields();

    await userEvent.click(screen.getByRole('button', { name: /test capture now/i }));

    await waitFor(() => expect(onPreview).toHaveBeenCalledTimes(1));
    expect(onPreview.mock.calls[0]?.[0]).toMatchObject({ url: 'https://example.com/pricing' });

    expect(await screen.findByText('Acme Pricing')).toBeInTheDocument();
    expect(screen.getByAltText(/preview of the captured page/i)).toBeInTheDocument();
    expect(screen.getByText('1280×900')).toBeInTheDocument();
    expect(screen.getByText(/43.9 KB/)).toBeInTheDocument();
    expect(screen.getByText(/1.23 s/)).toBeInTheDocument();
  });

  it('does not save anything when previewing', async () => {
    const { onSubmit } = renderForm({ onPreview: vi.fn().mockResolvedValue(previewResult) });
    await fillRequiredFields();

    await userEvent.click(screen.getByRole('button', { name: /test capture now/i }));
    await waitFor(() =>
      expect(screen.getByAltText(/preview of the captured page/i)).toBeInTheDocument(),
    );

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('reports a failed preview with the reason', async () => {
    renderForm({
      onPreview: vi.fn().mockResolvedValue({
        ...previewResult,
        ok: false,
        error: 'net::ERR_TIMED_OUT',
        screenshotBase64: null,
      }),
    });
    await fillRequiredFields();

    await userEvent.click(screen.getByRole('button', { name: /test capture now/i }));
    expect(await screen.findByText(/preview capture failed/i)).toBeInTheDocument();
    expect(screen.getByText(/ERR_TIMED_OUT/)).toBeInTheDocument();
  });

  it('lists requests the SSRF guard blocked during a preview', async () => {
    renderForm({
      onPreview: vi.fn().mockResolvedValue({
        ...previewResult,
        blockedRequests: [{ url: 'http://169.254.169.254/latest', reason: 'cloud-metadata' }],
      }),
    });
    await fillRequiredFields();

    await userEvent.click(screen.getByRole('button', { name: /test capture now/i }));
    expect(await screen.findByText(/blocked by the ssrf guard/i)).toBeInTheDocument();

    const details = screen.getByText(/which ones/i);
    await userEvent.click(details);
    expect(await screen.findByText('cloud-metadata')).toBeInTheDocument();
    expect(screen.getByText('http://169.254.169.254/latest')).toBeInTheDocument();
  });

  it('explains when the screenshot was too large to return inline', async () => {
    renderForm({
      onPreview: vi
        .fn()
        .mockResolvedValue({ ...previewResult, screenshotBase64: null, bytes: 9_000_000 }),
    });
    await fillRequiredFields();

    await userEvent.click(screen.getByRole('button', { name: /test capture now/i }));
    expect(await screen.findByText(/too large to return inline/i)).toBeInTheDocument();
  });

  it('disables the preview button while the form is invalid', async () => {
    renderForm({ onPreview: vi.fn() });

    const preview = screen.getByRole('button', { name: /test capture now/i });
    expect(preview).toBeDisabled();
    expect(preview).toHaveAttribute('title', 'Fix the errors above first');

    await fillRequiredFields();
    const enabled = screen.getByRole('button', { name: /test capture now/i });
    expect(enabled).toBeEnabled();
    expect(enabled).toHaveAttribute('title', 'Capture the page once, without saving');
  });

  it('shows progress while capturing', () => {
    renderForm({ onPreview: vi.fn(), previewPending: true });
    const button = screen.getByRole('button', { name: /capturing/i });
    expect(button).toBeDisabled();
    expect(screen.getByRole('status', { name: /capturing/i })).toBeInTheDocument();
  });

  it('surfaces a thrown preview error', async () => {
    renderForm({ onPreview: vi.fn().mockRejectedValue(new Error('browser unavailable')) });
    await fillRequiredFields();

    await userEvent.click(screen.getByRole('button', { name: /test capture now/i }));
    expect(await screen.findByText(/browser unavailable/i)).toBeInTheDocument();
  });

  it('reveals the extracted text on demand', async () => {
    renderForm({ onPreview: vi.fn().mockResolvedValue(previewResult) });
    await fillRequiredFields();
    await userEvent.click(screen.getByRole('button', { name: /test capture now/i }));

    const summary = await screen.findByText(/extracted text/i);
    await userEvent.click(summary);
    expect(await screen.findByText(/simple, per-seat pricing/i)).toBeInTheDocument();
  });
});
