import type { IncomingMessage } from 'node:http';

/**
 * A very small HTTP client used by the demo and the seed script.
 *
 * It exists because those scripts have to talk to the real API - including cookie
 * sessions and CSRF - and pulling in a client library just for them is not worth a
 * dependency. Node's own fetch does not manage a cookie jar, so this keeps one.
 */
export class ApiClient {
  private readonly cookies = new Map<string, string>();
  private csrf: string | null = null;

  constructor(readonly baseUrl: string) {}

  get token(): string | null {
    return this.csrf;
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  private absorbCookies(response: Response): void {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const entry of raw) {
      const [pair] = entry.split(';');
      if (!pair) continue;
      const index = pair.indexOf('=');
      if (index < 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '' || entry.toLowerCase().includes('max-age=0')) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
      if (name === 'pagefreeze_csrf') this.csrf = value;
    }
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T | null; text: string }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const cookie = this.cookieHeader();
    if (cookie) headers['cookie'] = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';

    if (this.csrf) headers['x-csrf-token'] = this.csrf;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    this.absorbCookies(response);

    const text = await response.text();
    let data: T | null = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        data = null;
      }
    }
    return { status: response.status, data, text };
  }

  get<T>(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<{ status: number; data: T | null; text: string }> {
    let url = path;
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        params.set(key, String(value));
      }
      const encoded = params.toString();
      if (encoded) url += `${path.includes('?') ? '&' : '?'}${encoded}`;
    }
    return this.request<T>('GET', url);
  }

  post<T>(path: string, body?: unknown): Promise<{ status: number; data: T | null; text: string }> {
    return this.request<T>('POST', path, body ?? {});
  }

  patch<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T | null; text: string }> {
    return this.request<T>('PATCH', path, body ?? {});
  }

  delete<T>(path: string): Promise<{ status: number; data: T | null; text: string }> {
    return this.request<T>('DELETE', path);
  }

  /** Binary fetch, for downloading a screenshot during verification. */
  async buffer(path: string): Promise<{ status: number; contentType: string; body: Buffer }> {
    const headers: Record<string, string> = {};
    const cookie = this.cookieHeader();
    if (cookie) headers['cookie'] = cookie;

    const response = await fetch(`${this.baseUrl}${path}`, { headers });
    const arrayBuffer = await response.arrayBuffer();
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      body: Buffer.from(arrayBuffer),
    };
  }
}

/** Read a request body as a string, bounded so a large upload cannot exhaust memory. */
export async function readBody(request: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
