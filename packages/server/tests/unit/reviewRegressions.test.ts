import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { SsrfGuard } from '../../src/capture/ssrf.js';
import { FetchHttpClient } from '../../src/notify/httpClient.js';
import { WorkerDiffEngine } from '../../src/diff/engine.js';
import { DEFAULT_DIFF_OPTIONS } from '../../src/diff/types.js';

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};
const close = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
};
const post = {
  headers: {},
  body: '{}',
  timeoutMs: 2000,
  redirect: 'follow' as const,
  maxRedirects: 1,
};

describe('outbound request regressions', () => {
  it('does not cache an allowlisted port exemption for other ports on the same hostname', async () => {
    const guard = new SsrfGuard({
      allowedHosts: ['fixture.test:4000'],
      resolver: { lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
    });
    expect((await guard.checkUrl('http://fixture.test:4000')).allowed).toBe(true);
    expect((await guard.checkUrl('http://fixture.test:4001')).allowed).toBe(false);
  });

  it('pins a hostname to the validated address and checks the redirect destination', async () => {
    let privateHits = 0;
    const target = createServer((_req, res) => {
      privateHits++;
      res.end('private');
    });
    const targetPort = await listen(target);
    const origin = createServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${targetPort}` });
      res.end();
    });
    const originPort = await listen(origin);
    const guard = new SsrfGuard({
      allowedHosts: [`fixture.test:${originPort}`],
      resolver: { lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
    });
    try {
      await expect(
        new FetchHttpClient(guard).post({ ...post, url: `http://fixture.test:${originPort}` }),
      ).rejects.toThrow('SSRF');
      expect(privateHits).toBe(0);
    } finally {
      await close(origin);
      await close(target);
    }
  });

  it('stops reading at the response limit even when the server does not end the body', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.write('x'.repeat(8192));
    });
    const port = await listen(server);
    try {
      const result = await new FetchHttpClient(
        new SsrfGuard({ allowedHosts: [`127.0.0.1:${port}`] }),
      ).post({ ...post, url: `http://127.0.0.1:${port}` });
      expect(result.body).toHaveLength(4096);
      expect(result.status).toBe(200);
    } finally {
      await close(server);
    }
  });

  it('enforces a redirect count on an otherwise allowed endpoint', async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.writeHead(307, { location: '/again' });
      res.end();
    });
    const port = await listen(server);
    try {
      await expect(
        new FetchHttpClient(new SsrfGuard({ allowedHosts: [`127.0.0.1:${port}`] })).post({
          ...post,
          url: `http://127.0.0.1:${port}`,
        }),
      ).rejects.toThrow('redirect limit');
      expect(hits).toBe(2);
    } finally {
      await close(server);
    }
  });
});

describe('diff worker concurrency', () => {
  it('keeps simultaneous comparisons paired with their own results', async () => {
    const engine = new WorkerDiffEngine({ timeoutMs: 5000 });
    const base = {
      beforeScreenshot: null,
      afterScreenshot: null,
      beforeText: 'old',
      beforeHtml: null,
      afterHtml: null,
      options: DEFAULT_DIFF_OPTIONS,
    };
    try {
      const results = await Promise.all([
        engine.diff({ ...base, afterText: 'first' }),
        engine.diff({ ...base, afterText: 'second' }),
      ]);
      expect(results[0]?.text?.unified).toContain('+first');
      expect(results[0]?.text?.unified).not.toContain('+second');
      expect(results[1]?.text?.unified).toContain('+second');
    } finally {
      await engine.close();
    }
  });
});
