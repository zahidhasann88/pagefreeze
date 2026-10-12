import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';
import type {
  ApiToken,
  ApiTokenCreated,
  Change,
  ChangeDetail,
  ChannelTestResult,
  CompareResult,
  MeResponse,
  Monitor,
  MonitorFormValues,
  MonitorSummary,
  NotificationChannel,
  Page,
  PreviewResult,
  ShareLink,
  ShareSummary,
  Snapshot,
  SystemInfo,
} from './types.js';

export const keys = {
  me: ['me'] as const,
  monitors: (params?: unknown) => ['monitors', 'list', params ?? {}] as const,
  monitor: (id: string) => ['monitors', 'detail', id] as const,
  snapshots: (id: string, params?: unknown) => ['monitors', id, 'snapshots', params ?? {}] as const,
  changes: (id: string, params?: unknown) => ['monitors', id, 'changes', params ?? {}] as const,
  change: (id: string) => ['changes', 'detail', id] as const,
  compare: (a: string, b: string, store: boolean) => ['compare', a, b, store] as const,
  channels: ['channels'] as const,
  tokens: ['tokens'] as const,
  systemInfo: ['system', 'info'] as const,
  shares: (changeId: string) => ['changes', changeId, 'shares'] as const,
};

export function useMe(enabled = true) {
  return useQuery({
    queryKey: keys.me,
    queryFn: () => api.get<MeResponse>('/auth/me'),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}
export interface MonitorListParams {
  status?: 'ok' | 'changed' | 'failing' | 'paused' | 'all';
  tag?: string;
  q?: string;
  limit?: number;
  cursor?: string;
}

export function useMonitors(params: MonitorListParams) {
  return useQuery({
    queryKey: keys.monitors(params),
    queryFn: ({ signal }) => api.get<Page<MonitorSummary>>('/monitors', params, signal),
    placeholderData: (previous) => previous,
  });
}

export function useMonitor(id: string | undefined, options: PollOptions = {}) {
  return useQuery({
    queryKey: keys.monitor(id ?? ''),
    queryFn: ({ signal }) => api.get<Monitor>(`/monitors/${id}`, undefined, signal),
    enabled: Boolean(id),
    ...(options.refetchIntervalMs ? { refetchInterval: options.refetchIntervalMs } : {}),
  });
}
export interface PollOptions {
  refetchIntervalMs?: number | false;
}

export function useSnapshots(
  monitorId: string | undefined,
  params: { limit?: number; cursor?: string; status?: 'success' | 'failed' | 'all' },
  options: PollOptions = {},
) {
  return useQuery({
    queryKey: keys.snapshots(monitorId ?? '', params),
    queryFn: ({ signal }) =>
      api.get<Page<Snapshot>>(`/monitors/${monitorId}/snapshots`, params, signal),
    enabled: Boolean(monitorId),
    placeholderData: (previous) => previous,
    ...(options.refetchIntervalMs ? { refetchInterval: options.refetchIntervalMs } : {}),
  });
}

export function useChanges(
  monitorId: string | undefined,
  params: { limit?: number; cursor?: string; significant?: 'true' | 'false' | 'all' },
  options: PollOptions = {},
) {
  return useQuery({
    queryKey: keys.changes(monitorId ?? '', params),
    queryFn: ({ signal }) =>
      api.get<Page<Change>>(`/monitors/${monitorId}/changes`, params, signal),
    enabled: Boolean(monitorId),
    placeholderData: (previous) => previous,
    ...(options.refetchIntervalMs ? { refetchInterval: options.refetchIntervalMs } : {}),
  });
}

export function useChange(changeId: string | undefined) {
  return useQuery({
    queryKey: keys.change(changeId ?? ''),
    queryFn: ({ signal }) => api.get<ChangeDetail>(`/changes/${changeId}`, undefined, signal),
    enabled: Boolean(changeId),
  });
}

export function useCompare(a: string | undefined, b: string | undefined, store = false) {
  return useQuery({
    queryKey: keys.compare(a ?? '', b ?? '', store),
    queryFn: ({ signal }) =>
      api.get<CompareResult>('/compare', { a, b, store: store ? 'true' : 'false' }, signal),
    enabled: Boolean(a && b),
  });
}

export function useChannels() {
  return useQuery({
    queryKey: keys.channels,
    queryFn: ({ signal }) =>
      api.get<{ data: NotificationChannel[] }>('/channels', undefined, signal),
  });
}

export function useTokens() {
  return useQuery({
    queryKey: keys.tokens,
    queryFn: ({ signal }) => api.get<{ data: ApiToken[] }>('/tokens', undefined, signal),
  });
}

export function useSystemInfo() {
  return useQuery({
    queryKey: keys.systemInfo,
    queryFn: ({ signal }) => api.get<SystemInfo>('/system/info', undefined, signal),
    staleTime: 15_000,
  });
}

function useInvalidator() {
  const client = useQueryClient();
  return (patterns: ReadonlyArray<readonly unknown[]>) => {
    for (const pattern of patterns) {
      void client.invalidateQueries({ queryKey: pattern });
    }
  };
}

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (credentials: { username: string; password: string }) =>
      api.post<MeResponse>('/auth/login', credentials),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.me });
    },
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>('/auth/logout'),
    onSettled: () => {
      client.clear();
    },
  });
}

export function useCreateMonitor() {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (values: MonitorFormValues) => api.post<Monitor>('/monitors', values),
    onSuccess: () => invalidate([['monitors']]),
  });
}

export function useUpdateMonitor(id: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (values: Partial<MonitorFormValues>) =>
      api.patch<Monitor>(`/monitors/${id}`, values),
    onSuccess: () => invalidate([['monitors'], keys.monitor(id)]),
  });
}

export function useDeleteMonitor() {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/monitors/${id}`),
    onSuccess: () => invalidate([['monitors']]),
  });
}

export function useCaptureNow(id: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: () => api.post<{ jobId: string | null; mode: string }>(`/monitors/${id}/capture`),
    onSuccess: () =>
      invalidate([['monitors'], keys.monitor(id), keys.snapshots(id), keys.changes(id)]),
  });
}

export function useSetPaused(id: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (paused: boolean) =>
      api.post<Monitor>(`/monitors/${id}/${paused ? 'pause' : 'resume'}`),
    onSuccess: () => invalidate([['monitors'], keys.monitor(id)]),
  });
}

export function usePreviewCapture() {
  return useMutation({
    mutationFn: (values: MonitorFormValues) => api.post<PreviewResult>('/monitors/preview', values),
  });
}

export function useCreateChannel() {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (values: unknown) => api.post<NotificationChannel>('/channels', values),
    onSuccess: () => invalidate([keys.channels]),
  });
}

export function useUpdateChannel(id: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (values: unknown) => api.patch<NotificationChannel>(`/channels/${id}`, values),
    onSuccess: () => invalidate([keys.channels]),
  });
}

export function useDeleteChannel() {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/channels/${id}`),
    onSuccess: () => invalidate([keys.channels]),
  });
}

export function useTestChannel(id: string) {
  return useMutation({
    mutationFn: (message?: string) =>
      api.post<ChannelTestResult>(`/channels/${id}/test`, message ? { message } : {}),
  });
}

export function useCreateToken() {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (values: { name: string; expiresInDays: number | null }) =>
      api.post<ApiTokenCreated>('/tokens', values),
    onSuccess: () => invalidate([keys.tokens]),
  });
}

export function useRevokeToken() {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/tokens/${id}`),
    onSuccess: () => invalidate([keys.tokens]),
  });
}

export function useCreateShare(changeId: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (expiresInHours: number | null) =>
      api.post<ShareLink>(`/changes/${changeId}/share`, { expiresInHours }),
    onSuccess: () => invalidate([keys.change(changeId), keys.shares(changeId)]),
  });
}

export function useRevokeShare(changeId: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (shareId: string) => api.delete<void>(`/shares/${shareId}`),
    onSuccess: () => invalidate([keys.change(changeId), keys.shares(changeId)]),
  });
}

export function useShares(changeId: string | undefined) {
  return useQuery({
    queryKey: keys.shares(changeId ?? ''),
    queryFn: ({ signal }) =>
      api.get<{ data: ShareSummary[] }>(`/changes/${changeId}/shares`, undefined, signal),
    enabled: Boolean(changeId),
  });
}
