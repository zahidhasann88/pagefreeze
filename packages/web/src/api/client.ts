export const API_PREFIX = '/api/v1';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
export interface Page<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * The CSRF cookie is deliberately readable by scripts (the session cookie is httpOnly).
 * Reading it here and echoing it in a header is the double-submit half of the check.
 */
export function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = /(?:^|;\s*)pagefreeze_csrf=([^;]+)/.exec(document.cookie);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  raw?: boolean;
  query?: QueryParams;
}

/** Values are stringified; null, undefined and empty strings are dropped. */
export type QueryParams = Record<string, string | number | boolean | null | undefined>;

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };

  if (options.body !== undefined) headers['content-type'] = 'application/json';

  if (
    MUTATING.has(method) ||
    options.query?.['store'] === 'true' ||
    options.query?.['store'] === true
  ) {
    const csrf = readCsrfCookie();
    if (csrf) headers['x-csrf-token'] = csrf;
  }

  let url = `${API_PREFIX}${path}`;
  if (options.query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }
    const encoded = params.toString();
    if (encoded) url += `?${encoded}`;
  }

  const response = await fetch(url, {
    method,
    headers,
    credentials: 'same-origin',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (options.raw) {
    if (!response.ok) throw await toApiError(response);
    return (await response.blob()) as T;
  }

  const text = await response.text();
  const parsed = text.length > 0 ? safeJsonParse(text) : null;

  if (!response.ok) {
    throw toApiErrorFromBody(response.status, parsed);
  }

  return parsed as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const text = await response.text().catch(() => '');
  return toApiErrorFromBody(response.status, safeJsonParse(text));
}

function toApiErrorFromBody(status: number, parsed: unknown): ApiError {
  const body = parsed as { error?: { code?: string; message?: string; details?: unknown } } | null;
  return new ApiError(
    status,
    body?.error?.code ?? 'unknown',
    body?.error?.message ?? `Request failed with status ${status}`,
    body?.error?.details,
  );
}

export const api = {
  get: <T>(path: string, query?: QueryParams | object, signal?: AbortSignal) =>
    apiRequest<T>(path, { query: query as QueryParams | undefined, signal }),
  post: <T>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: 'POST', body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: 'PATCH', body: body ?? {} }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
};

export function artifactUrl(path: string): string {
  return `${API_PREFIX}${path}`;
}

export const urls = {
  screenshot: (snapshotId: string) => artifactUrl(`/snapshots/${snapshotId}/screenshot`),
  html: (snapshotId: string) => artifactUrl(`/snapshots/${snapshotId}/html`),
  text: (snapshotId: string) => artifactUrl(`/snapshots/${snapshotId}/text`),
  diffImage: (changeId: string) => artifactUrl(`/changes/${changeId}/diff-image`),
};
