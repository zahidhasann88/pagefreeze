import { Link, useNavigate, useParams } from 'react-router-dom';
import { MonitorForm } from '../components/MonitorForm.js';
import {
  useChannels,
  useCreateMonitor,
  useMonitor,
  usePreviewCapture,
  useUpdateMonitor,
} from '../api/hooks.js';
import { ErrorState, LoadingState, describeError } from '../components/ui.js';
import type { MonitorFormValues } from '../api/types.js';

/**
 * Create and edit share one form. Editing loads the stored monitor and maps it onto the
 * form values; secret *values* are not available (the API never returns them), so the
 * header and cookie editors start empty and only the stored names are shown. Leaving them
 * empty preserves what is already stored.
 */
export function MonitorFormPage() {
  const { monitorId } = useParams<{ monitorId: string }>();
  const navigate = useNavigate();
  const isEdit = Boolean(monitorId);

  const channelsQuery = useChannels();
  const monitorQuery = useMonitor(monitorId);
  const create = useCreateMonitor();
  const update = useUpdateMonitor(monitorId ?? '');
  const preview = usePreviewCapture();

  if (isEdit && monitorQuery.isLoading) return <LoadingState label="Loading monitor…" />;
  if (isEdit && monitorQuery.isError) {
    return <ErrorState error={monitorQuery.error} title="Could not load that monitor" />;
  }
  if (isEdit && !monitorQuery.data) return <ErrorState error="Monitor not found" />;

  const monitor = monitorQuery.data;

  const initialValues: Partial<MonitorFormValues> | undefined = monitor
    ? {
        name: monitor.name,
        url: monitor.url,
        tags: monitor.tags,
        enabled: monitor.enabled,
        scheduleKind: monitor.scheduleKind,
        scheduleValue: monitor.scheduleValue,
        devicePreset: monitor.devicePreset,
        viewportWidth: monitor.viewportWidth,
        viewportHeight: monitor.viewportHeight,
        fullPage: monitor.fullPage,
        waitStrategy: monitor.waitStrategy,
        waitSelector: monitor.waitSelector,
        extraDelayMs: monitor.extraDelayMs,
        captureSelector: monitor.captureSelector,
        ignoreSelectors: monitor.ignoreSelectors,
        userAgent: monitor.userAgent,
        changeThreshold: monitor.changeThreshold,
        detectText: monitor.detectText,
        detectHtml: monitor.detectHtml,
        retentionDays: monitor.retentionDays,
        channelIds: monitor.channelIds,
        headers: {},
        cookies: [],
      }
    : undefined;

  const submitting = create.isPending || update.isPending;
  const submitError = create.isError
    ? describeError(create.error)
    : update.isError
      ? describeError(update.error)
      : null;

  const onSubmit = (values: MonitorFormValues): void => {
    if (isEdit && monitorId) {
      // Only send the secret fields when the operator actually entered something; sending
      // an empty object would wipe the stored credentials.
      const payload: Partial<MonitorFormValues> = { ...values };
      if (Object.keys(values.headers).length === 0) delete payload.headers;
      if (values.cookies.length === 0) delete payload.cookies;

      update.mutate(payload, {
        onSuccess: () => navigate(`/monitors/${monitorId}`),
      });
      return;
    }

    create.mutate(values, {
      onSuccess: (created) => navigate(`/monitors/${created.id}`),
    });
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div className="page-head__title">
          <h1>{isEdit ? 'Edit monitor' : 'New monitor'}</h1>
          <div className="page-head__subtitle">
            {isEdit && monitor ? (
              <Link to={`/monitors/${monitor.id}`}>{monitor.url}</Link>
            ) : (
              'Point Pagefreeze at a page and choose how often to look at it.'
            )}
          </div>
        </div>
      </div>

      <MonitorForm
        // Keyed so switching between monitors resets the form state.
        key={monitorId ?? 'new'}
        initialValues={initialValues}
        channels={channelsQuery.data?.data ?? []}
        submitting={submitting}
        submitLabel={isEdit ? 'Save changes' : 'Create monitor'}
        submitError={submitError}
        onSubmit={onSubmit}
        onCancel={() => navigate(isEdit && monitorId ? `/monitors/${monitorId}` : '/')}
        existingSecrets={
          monitor
            ? {
                headerNames: monitor.secrets.headerNames,
                cookieNames: monitor.secrets.cookieNames,
              }
            : undefined
        }
        onPreview={async (values) => {
          const result = await preview.mutateAsync(values);
          return result;
        }}
        previewPending={preview.isPending}
      />
    </div>
  );
}
