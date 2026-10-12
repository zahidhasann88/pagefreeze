import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { SsrfGuard } from '../capture/ssrf.js';
import type { HttpClient } from './notifier.js';

type PostOptions = Parameters<HttpClient['post']>[0];
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export class FetchHttpClient implements HttpClient {
  constructor(private readonly guard = new SsrfGuard()) {}

  async post(options: PostOptions): Promise<{ status: number; body: string }> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('webhook timeout')),
      options.timeoutMs,
    );
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true,
      });
    });
    try {
      return await Promise.race([this.deliver(options, controller.signal), aborted]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async deliver(
    options: PostOptions,
    signal: AbortSignal,
  ): Promise<{ status: number; body: string }> {
    let url = new URL(options.url);
    const limit = options.redirect === 'follow' ? (options.maxRedirects ?? 0) : 0;
    for (let hops = 0; ; hops += 1) {
      const verdict = await this.guard.checkUrl(url.href);
      signal.throwIfAborted();
      const address = verdict.addresses[0];
      if (!verdict.allowed || !address) {
        throw new Error(`destination blocked by SSRF guard: ${verdict.reason ?? 'no address'}`);
      }
      const response = await this.request(url, address, options, signal);
      if (!REDIRECTS.has(response.status) || !response.location || options.redirect === 'manual') {
        return { status: response.status, body: response.body };
      }
      if (hops >= limit) throw new Error('webhook redirect limit exceeded');

      url = new URL(response.location, url);
    }
  }

  private request(
    url: URL,
    address: string,
    options: PostOptions,
    signal: AbortSignal,
  ): Promise<{ status: number; body: string; location?: string }> {
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        {
          hostname: address,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          servername: url.hostname.replace(/^\[|\]$/g, ''),
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            ...options.headers,
            host: url.host,
            'content-length': Buffer.byteLength(options.body),
          },
          agent: false,
          signal,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const finish = () =>
            resolve({
              status: response.statusCode ?? 502,
              body: Buffer.concat(chunks).toString('utf8'),
              ...(response.headers.location ? { location: response.headers.location } : {}),
            });
          response.on('data', (chunk: Buffer) => {
            const remaining = 4096 - size;
            chunks.push(chunk.subarray(0, remaining));
            size += Math.min(chunk.length, remaining);
            if (size >= 4096) {
              finish();
              response.destroy();
            }
          });
          response.on('end', finish);
          response.on('error', reject);
          response.on('aborted', () => {
            if (size < 4096) reject(new Error('webhook response interrupted'));
          });
        },
      );
      request.on('error', reject);
      request.end(options.body);
    });
  }
}

export function createHttpClient(guard?: SsrfGuard): HttpClient {
  return new FetchHttpClient(guard);
}
