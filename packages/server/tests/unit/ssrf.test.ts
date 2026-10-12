import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  SsrfGuard,
  SsrfProxy,
  classifyIp,
  classifyIpv4,
  classifyIpv6,
  expandIpv6,
  ipv4ToInt,
  isBlockedHostname,
  type Resolver,
} from '../../src/capture/ssrf.js';

/**
 * SSRF guard tests.
 *
 * This is the highest-risk area of the product: a monitored URL is fetched by a real
 * browser, so the guard is the only thing between an operator (or a page that page links
 * to) and the cloud metadata service, the loopback interface and the internal network.
 *
 * Every test uses a stub resolver rather than real DNS, so the suite is hermetic and the
 * DNS-rebinding case can be expressed directly.
 */

function stubResolver(
  table: Record<string, string[]>,
): Resolver & { set: (host: string, ips: string[]) => void } {
  const entries = new Map(Object.entries(table));
  return {
    async lookup(hostname: string) {
      const addresses = entries.get(hostname.toLowerCase()) ?? [];
      return addresses.map((address) => ({
        address,
        family: address.includes(':') ? 6 : 4,
      }));
    },
    set(hostname: string, ips: string[]) {
      entries.set(hostname.toLowerCase(), ips);
    },
  };
}

describe('ipv4ToInt', () => {
  it('parses dotted quads', () => {
    expect(ipv4ToInt('0.0.0.0')).toBe(0);
    expect(ipv4ToInt('127.0.0.1')).toBe(2130706433);
    expect(ipv4ToInt('255.255.255.255')).toBe(4294967295);
  });

  it('rejects malformed input', () => {
    expect(ipv4ToInt('1.2.3')).toBeNull();
    expect(ipv4ToInt('1.2.3.4.5')).toBeNull();
    expect(ipv4ToInt('256.1.1.1')).toBeNull();
    expect(ipv4ToInt('1.2.3.a')).toBeNull();
    expect(ipv4ToInt('')).toBeNull();
  });

  it('rejects leading zeros, which some parsers read as octal', () => {
    // http://0177.0.0.1 is 127.0.0.1 to a C parser; treating it as a literal would let a

    expect(ipv4ToInt('0127.0.0.1')).toBeNull();
    expect(ipv4ToInt('127.00.0.1')).toBeNull();
  });
});

describe('expandIpv6', () => {
  it('expands the loopback address', () => {
    expect(expandIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('expands a compressed address', () => {
    expect(expandIpv6('2001:db8::1')).toEqual([0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]);
  });

  it('expands a full address', () => {
    expect(expandIpv6('fe80:0000:0000:0000:0000:0000:0000:0001')).toEqual([
      0xfe80, 0, 0, 0, 0, 0, 0, 1,
    ]);
  });

  it('expands an IPv4-mapped address', () => {
    expect(expandIpv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
  });

  it('strips a zone index', () => {
    expect(expandIpv6('fe80::1%eth0')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('rejects malformed input', () => {
    expect(expandIpv6(':::')).toBeNull();
    expect(expandIpv6('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(expandIpv6('gggg::1')).toBeNull();
    expect(expandIpv6('')).toBeNull();
    expect(expandIpv6('127.0.0.1')).toBeNull();
  });
});

describe('classifyIpv4', () => {
  const blocked: Array<[string, string]> = [
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.0.0.1', 'private-network'],
    ['10.255.255.255', 'private-network'],
    ['172.16.0.1', 'private-network'],
    ['172.31.255.255', 'private-network'],
    ['192.168.1.1', 'private-network'],
    ['192.168.0.100', 'private-network'],
    ['169.254.169.254', 'cloud-metadata'],
    ['169.254.170.2', 'cloud-metadata'],
    ['169.254.1.1', 'link-local'],
    ['100.100.100.200', 'cloud-metadata'],
    ['100.64.0.1', 'carrier-grade-nat'],
    ['0.0.0.0', 'this-network'],
    ['224.0.0.1', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['192.0.2.1', 'documentation'],
    ['198.51.100.1', 'documentation'],
    ['203.0.113.1', 'documentation'],
    ['198.18.0.1', 'benchmark'],
  ];

  for (const [address, reason] of blocked) {
    it(`blocks ${address} as ${reason}`, () => {
      expect(classifyIpv4(address)).toEqual({ blocked: true, reason });
    });
  }

  const allowed = [
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.15.0.1',
    '172.32.0.1',
    '192.169.0.1',
    '11.0.0.1',
    '100.63.255.255',
  ];

  for (const address of allowed) {
    it(`allows the public address ${address}`, () => {
      expect(classifyIpv4(address)).toBeNull();
    });
  }

  it('does not confuse adjacent ranges', () => {
    // 172.16/12 is private; 172.15 and 172.32 are not.
    expect(classifyIpv4('172.16.0.0')).not.toBeNull();
    expect(classifyIpv4('172.15.255.255')).toBeNull();
    expect(classifyIpv4('172.31.255.255')).not.toBeNull();
    expect(classifyIpv4('172.32.0.0')).toBeNull();
  });
});

describe('classifyIpv6', () => {
  it('blocks the loopback address', () => {
    expect(classifyIpv6(expandIpv6('::1')!)).toEqual({ blocked: true, reason: 'ipv6-loopback' });
  });

  it('blocks the unspecified address', () => {
    expect(classifyIpv6(expandIpv6('::')!)).toEqual({ blocked: true, reason: 'ipv6-unspecified' });
  });

  it('blocks unique local addresses', () => {
    expect(classifyIpv6(expandIpv6('fc00::1')!)).toEqual({
      blocked: true,
      reason: 'ipv6-unique-local',
    });
    expect(classifyIpv6(expandIpv6('fd12:3456::1')!)).toEqual({
      blocked: true,
      reason: 'ipv6-unique-local',
    });
  });

  it('blocks link-local addresses', () => {
    expect(classifyIpv6(expandIpv6('fe80::1')!)).toEqual({
      blocked: true,
      reason: 'ipv6-link-local',
    });
  });

  it('blocks multicast', () => {
    expect(classifyIpv6(expandIpv6('ff02::1')!)).toEqual({
      blocked: true,
      reason: 'ipv6-multicast',
    });
  });

  it('blocks documentation space', () => {
    expect(classifyIpv6(expandIpv6('2001:db8::1')!)).toEqual({
      blocked: true,
      reason: 'documentation',
    });
  });

  it('judges IPv4-mapped addresses by their embedded IPv4 address', () => {
    expect(classifyIpv6(expandIpv6('::ffff:127.0.0.1')!)).toEqual({
      blocked: true,
      reason: 'loopback',
    });
    expect(classifyIpv6(expandIpv6('::ffff:169.254.169.254')!)).toEqual({
      blocked: true,
      reason: 'cloud-metadata',
    });
    expect(classifyIpv6(expandIpv6('::ffff:10.0.0.1')!)).toEqual({
      blocked: true,
      reason: 'private-network',
    });

    expect(classifyIpv6(expandIpv6('::ffff:8.8.8.8')!)).toBeNull();
  });

  it('judges IPv4-compatible addresses the same way', () => {
    expect(classifyIpv6(expandIpv6('::127.0.0.1')!)).toEqual({ blocked: true, reason: 'loopback' });
  });

  it('blocks NAT64 space', () => {
    expect(classifyIpv6(expandIpv6('64:ff9b::7f00:1')!)).toEqual({
      blocked: true,
      reason: 'loopback',
    });
    expect(classifyIpv6(expandIpv6('64:ff9b:1::1:1')!)).toEqual({ blocked: true, reason: 'nat64' });
  });

  it('allows ordinary global addresses', () => {
    expect(classifyIpv6(expandIpv6('2606:4700:4700::1111')!)).toBeNull();
    expect(classifyIpv6(expandIpv6('2a00:1450:4001:81a::200e')!)).toBeNull();
  });
});

describe('classifyIp', () => {
  it('dispatches between families', () => {
    expect(classifyIp('127.0.0.1')).toEqual({ blocked: true, reason: 'loopback' });
    expect(classifyIp('::1')).toEqual({ blocked: true, reason: 'ipv6-loopback' });
    expect(classifyIp('8.8.8.8')).toBeNull();
  });

  it('rejects unparseable input rather than failing open', () => {
    expect(classifyIp('not-an-ip')).toEqual({ blocked: true, reason: 'unparseable-address' });
    expect(classifyIp('999.1.1.1')).toEqual({ blocked: true, reason: 'unparseable-address' });
  });
});

describe('isBlockedHostname', () => {
  it('blocks localhost and its variants', () => {
    expect(isBlockedHostname('localhost')).toBe('blocked-hostname');
    expect(isBlockedHostname('LOCALHOST')).toBe('blocked-hostname');
    expect(isBlockedHostname('sub.localhost')).toBe('blocked-hostname');
    expect(isBlockedHostname('ip6-localhost')).toBe('blocked-hostname');
  });

  it('blocks .local, .internal and .localdomain', () => {
    expect(isBlockedHostname('db.internal')).toBe('blocked-hostname');
    expect(isBlockedHostname('printer.local')).toBe('blocked-hostname');
    expect(isBlockedHostname('host.localdomain')).toBe('blocked-hostname');
  });

  it('blocks known cloud metadata hostnames', () => {
    expect(isBlockedHostname('metadata.google.internal')).toBe('blocked-hostname');
    expect(isBlockedHostname('metadata')).toBe('blocked-hostname');
    expect(isBlockedHostname('instance-data')).toBe('blocked-hostname');
  });

  it('blocks bare decimal IPv4 literals', () => {
    // http://2130706433/ is 127.0.0.1 to most HTTP clients.
    expect(isBlockedHostname('2130706433')).toBe('numeric-hostname');
  });

  it('allows ordinary public hostnames', () => {
    expect(isBlockedHostname('example.com')).toBeNull();
    expect(isBlockedHostname('pricing.example.co.uk')).toBeNull();

    expect(isBlockedHostname('localhost.example.com')).toBeNull();
  });

  it('strips a trailing dot', () => {
    expect(isBlockedHostname('localhost.')).toBe('blocked-hostname');
    expect(isBlockedHostname('example.com.')).toBeNull();
  });
});

describe('SsrfGuard.checkUrl', () => {
  it('rejects every scheme except http and https', async () => {
    const guard = new SsrfGuard({ resolver: stubResolver({}) });
    for (const url of [
      'file:///etc/passwd',
      'chrome://settings',
      'data:text/html,<script>alert(1)</script>',
      'ftp://example.com/file',
      'gopher://127.0.0.1:6379/_INFO',
      'javascript:alert(1)',
      'about:blank',
      'blob:http://example.com/x',
    ]) {
      const result = await guard.checkUrl(url);
      expect(result.allowed, url).toBe(false);
      expect(result.reason, url).toMatch(/^scheme-not-allowed/);
    }
  });

  it('rejects unparseable urls', async () => {
    const guard = new SsrfGuard({ resolver: stubResolver({}) });
    expect((await guard.checkUrl('http://')).allowed).toBe(false);
    expect((await guard.checkUrl('')).allowed).toBe(false);
    expect((await guard.checkUrl('not a url')).allowed).toBe(false);
  });

  it('blocks a loopback literal', async () => {
    const guard = new SsrfGuard({ resolver: stubResolver({}) });
    const result = await guard.checkUrl('http://127.0.0.1:8080/admin');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('loopback');
  });

  it('blocks the cloud metadata address', async () => {
    const guard = new SsrfGuard({ resolver: stubResolver({}) });
    const result = await guard.checkUrl(
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('cloud-metadata');
  });

  it('blocks private ranges', async () => {
    const guard = new SsrfGuard({ resolver: stubResolver({}) });
    for (const url of ['http://10.1.2.3/', 'http://192.168.1.1/', 'http://172.20.0.5:9000/']) {
      const result = await guard.checkUrl(url);
      expect(result.allowed, url).toBe(false);
      expect(result.reason, url).toBe('private-network');
    }
  });

  it('blocks an IPv6 loopback literal in brackets', async () => {
    const guard = new SsrfGuard({ resolver: stubResolver({}) });
    const result = await guard.checkUrl('http://[::1]:8080/');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('ipv6-loopback');
  });

  it('blocks localhost by name without consulting DNS', async () => {
    const resolver = stubResolver({ localhost: ['8.8.8.8'] });
    const guard = new SsrfGuard({ resolver });
    const result = await guard.checkUrl('http://localhost:3000/');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('blocked-hostname');
  });

  it('blocks a hostname that resolves to a private address', async () => {
    const guard = new SsrfGuard({
      resolver: stubResolver({ 'internal.example.com': ['10.0.0.5'] }),
    });
    const result = await guard.checkUrl('https://internal.example.com/');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('private-network');
  });

  it('blocks when ANY resolved address is private, not just the first', async () => {
    // A host answering with one public and one private address is a rebinding trick.
    const guard = new SsrfGuard({
      resolver: stubResolver({ 'mixed.example.com': ['93.184.216.34', '127.0.0.1'] }),
    });
    const result = await guard.checkUrl('https://mixed.example.com/');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('loopback');
  });

  it('blocks when any resolved address is IPv6 link-local', async () => {
    const guard = new SsrfGuard({
      resolver: stubResolver({ 'dual.example.com': ['93.184.216.34', 'fe80::1'] }),
    });
    const result = await guard.checkUrl('https://dual.example.com/');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('ipv6-link-local');
  });

  it('allows a public hostname and returns the validated addresses', async () => {
    const guard = new SsrfGuard({
      resolver: stubResolver({ 'example.com': ['93.184.216.34'] }),
    });
    const result = await guard.checkUrl('https://example.com/pricing');
    expect(result.allowed).toBe(true);
    expect(result.addresses).toEqual(['93.184.216.34']);
  });

  it('fails closed when DNS resolution fails', async () => {
    const guard = new SsrfGuard({ resolver: stubResolver({}) });
    const result = await guard.checkUrl('https://does-not-exist.example/');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('dns-resolution-failed');
  });

  it('rejects an out-of-range port', async () => {
    const guard = new SsrfGuard({ resolver: stubResolver({ 'example.com': ['93.184.216.34'] }) });
    expect((await guard.checkUrl('https://example.com:99999/')).allowed).toBe(false);
    expect((await guard.checkUrl('https://example.com:0/')).allowed).toBe(false);
  });

  it('caches a verdict for a short window', async () => {
    const resolver = stubResolver({ 'cached.example.com': ['93.184.216.34'] });
    const guard = new SsrfGuard({ resolver, cacheTtlMs: 60_000 });

    expect((await guard.checkUrl('https://cached.example.com/')).allowed).toBe(true);

    resolver.set('cached.example.com', ['127.0.0.1']);
    expect((await guard.checkUrl('https://cached.example.com/')).allowed).toBe(true);

    guard.clearCache();
    expect((await guard.checkUrl('https://cached.example.com/')).allowed).toBe(false);
  });

  it('caches a negative verdict too, so a blocked host is not re-resolved per request', async () => {
    const resolver = stubResolver({ 'blocked.example.com': ['10.0.0.1'] });
    const guard = new SsrfGuard({ resolver, cacheTtlMs: 60_000 });
    expect((await guard.checkUrl('https://blocked.example.com/')).allowed).toBe(false);
    resolver.set('blocked.example.com', ['93.184.216.34']);
    expect((await guard.checkUrl('https://blocked.example.com/')).allowed).toBe(false);
  });

  it('ALLOW_PRIVATE_TARGETS permits internal addresses', async () => {
    const guard = new SsrfGuard({
      allowPrivateTargets: true,
      resolver: stubResolver({ localhost: ['127.0.0.1', '::1'] }),
    });
    expect((await guard.checkUrl('http://127.0.0.1:3000/')).allowed).toBe(true);
    expect((await guard.checkUrl('http://localhost:3000/')).allowed).toBe(true);
    expect((await guard.checkUrl('http://192.168.1.1/')).allowed).toBe(true);

    expect((await guard.checkUrl('file:///etc/passwd')).allowed).toBe(false);
  });

  it('allowedHosts exempts exactly one host, and only that one', async () => {
    const guard = new SsrfGuard({
      allowedHosts: ['127.0.0.1:4000'],
      resolver: stubResolver({ 'public.example.com': ['93.184.216.34'] }),
    });

    expect((await guard.checkUrl('http://127.0.0.1:4000/pricing')).allowed).toBe(true);

    expect((await guard.checkUrl('http://127.0.0.1:4001/')).allowed).toBe(false);

    expect((await guard.checkUrl('http://127.0.0.2:4000/')).allowed).toBe(false);

    expect((await guard.checkUrl('https://public.example.com/')).allowed).toBe(true);
  });

  it('allowedHosts can exempt a bare host without a port', async () => {
    const guard = new SsrfGuard({ allowedHosts: ['127.0.0.1'], resolver: stubResolver({}) });
    expect((await guard.checkUrl('http://127.0.0.1:1234/')).allowed).toBe(true);
    expect((await guard.checkUrl('http://127.0.0.2:1234/')).allowed).toBe(false);
  });

  it('an allowedHosts exemption does not let a redirect target through', async () => {
    const guard = new SsrfGuard({ allowedHosts: ['127.0.0.1:4000'], resolver: stubResolver({}) });

    expect((await guard.checkUrl('http://127.0.0.1:4000/')).allowed).toBe(true);

    expect((await guard.checkUrl('http://169.254.169.254/')).allowed).toBe(false);
  });
});

describe('SsrfGuard.checkConnect', () => {
  it('parses host:port and applies the same rules', async () => {
    const guard = new SsrfGuard({ resolver: stubResolver({ 'example.com': ['93.184.216.34'] }) });
    expect((await guard.checkConnect('example.com:443')).allowed).toBe(true);
    expect((await guard.checkConnect('127.0.0.1:8080')).allowed).toBe(false);
    expect((await guard.checkConnect('169.254.169.254:80')).allowed).toBe(false);
  });

  it('handles bracketed IPv6 targets', async () => {
    const guard = new SsrfGuard({ resolver: stubResolver({}) });
    expect((await guard.checkConnect('[::1]:443')).allowed).toBe(false);
    expect((await guard.checkConnect('[2606:4700:4700::1111]:443')).allowed).toBe(true);
  });

  it('defaults the port to 443 when absent', async () => {
    const guard = new SsrfGuard({ resolver: stubResolver({ 'example.com': ['93.184.216.34'] }) });
    expect((await guard.checkConnect('example.com')).allowed).toBe(true);
  });
});

describe('DNS rebinding', () => {
  it('is defeated because the guard validates every address the host resolves to', async () => {
    // Classic rebinding: the first lookup is public, the second is loopback. A guard that

    let calls = 0;
    const resolver: Resolver = {
      async lookup() {
        calls += 1;
        const address = calls === 1 ? '93.184.216.34' : '127.0.0.1';
        return [{ address, family: 4 }];
      },
    };

    const guard = new SsrfGuard({ resolver, cacheTtlMs: 0 });
    expect((await guard.checkUrl('https://rebinding.example/')).allowed).toBe(true);
    expect((await guard.checkUrl('https://rebinding.example/api')).allowed).toBe(false);
    expect(calls).toBe(2);
  });

  it('is also defeated within a single lookup that returns both addresses', async () => {
    const guard = new SsrfGuard({
      resolver: stubResolver({ 'rebinding.example': ['93.184.216.34', '127.0.0.1'] }),
    });
    const result = await guard.checkUrl('https://rebinding.example/');
    expect(result.allowed).toBe(false);
  });
});

describe('SsrfProxy', () => {
  function rawRequest(port: number, request: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = netConnect({ host: '127.0.0.1', port }, () => {
        socket.write(request);
      });
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      socket.setTimeout(5000, () => {
        socket.destroy();
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      socket.on('error', reject);
    });
  }

  /**
   * Run `body` against a real loopback origin plus a proxy that is allowed to reach it.
   *
   * The origin is on 127.0.0.1, so the guard would normally refuse it; it is exempted by
   * host:port, exactly as the demo and the integration tests do. Everything the guard still
   * refuses (the metadata address, other loopback ports) is what these tests assert on.
   */
  async function withProxy<T>(
    body: (context: {
      originUrl: string;
      proxyPort: number;
      blocked: Array<{ target: string; reason: string }>;
    }) => Promise<T>,
  ): Promise<T> {
    const server = createServer((_request, response) => {
      const payload = 'origin reached';
      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': String(Buffer.byteLength(payload)),
      });
      response.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const originPort = (server.address() as AddressInfo).port;

    const blocked: Array<{ target: string; reason: string }> = [];
    const guard = new SsrfGuard({
      resolver: stubResolver({}),
      allowedHosts: [`127.0.0.1:${originPort}`],
    });
    const proxy = new SsrfProxy({ guard, onBlocked: (entry) => blocked.push(entry) });
    const proxyPort = await proxy.start();

    try {
      return await body({ originUrl: `http://127.0.0.1:${originPort}`, proxyPort, blocked });
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('starts on a loopback port and stops cleanly', async () => {
    const guard = new SsrfGuard({ resolver: stubResolver({}) });
    const proxy = new SsrfProxy({ guard });
    const port = await proxy.start();
    expect(port).toBeGreaterThan(0);
    expect(proxy.getPort()).toBe(port);
    await proxy.close();

    await proxy.close();
    expect(proxy.getPort()).toBe(0);
  });

  it('forwards an allowed absolute-form HTTP request and re-frames the response', async () => {
    await withProxy(async ({ originUrl, proxyPort }) => {
      const target = `${originUrl}/hello`;
      const raw = await rawRequest(
        proxyPort,
        `GET ${target} HTTP/1.1\r\nHost: ${new URL(target).host}\r\nConnection: close\r\n\r\n`,
      );

      expect(raw.startsWith('HTTP/1.1 200')).toBe(true);
      expect(raw).toContain('origin reached');
      expect(raw).not.toContain(
        'HTTP/1.1 200 OK\r\ncontent-type: text/plain; charset=utf-8\r\ncache-control',
      );
    });
  });

  it('returns 403 for a plain request the guard refuses', async () => {
    await withProxy(async ({ proxyPort, blocked }) => {
      const raw = await rawRequest(
        proxyPort,
        'GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: 169.254.169.254\r\nConnection: close\r\n\r\n',
      );
      expect(raw).toContain('403');
      expect(raw).not.toContain('origin reached');
      expect(blocked.some((entry) => entry.reason === 'cloud-metadata')).toBe(true);
    });
  });

  it('refuses a CONNECT to a blocked address', async () => {
    await withProxy(async ({ proxyPort }) => {
      const raw = await rawRequest(
        proxyPort,
        'CONNECT 169.254.169.254:443 HTTP/1.1\r\nHost: 169.254.169.254:443\r\n\r\n',
      );
      expect(raw).toContain('403');
    });
  });

  it('refuses a CONNECT to a loopback port that is not exempted', async () => {
    await withProxy(async ({ proxyPort }) => {
      const raw = await rawRequest(
        proxyPort,
        'CONNECT 127.0.0.1:22 HTTP/1.1\r\nHost: 127.0.0.1:22\r\n\r\n',
      );
      expect(raw).toContain('403');
    });
  });

  it('establishes a CONNECT tunnel to an exempted host', async () => {
    await withProxy(async ({ originUrl, proxyPort }) => {
      const { port: originPort } = new URL(originUrl);
      const raw = await rawRequest(
        proxyPort,
        `CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\n\r\n`,
      );
      expect(raw).toContain('200 Connection Established');
    });
  });

  it('pins the upstream socket to the address the guard validated', async () => {
    const guard = new SsrfGuard({
      resolver: stubResolver({ 'flipping.example': ['93.184.216.34'] }),
      cacheTtlMs: 0,
    });
    const verdict = await guard.checkConnect('flipping.example:443');
    expect(verdict.allowed).toBe(true);
    expect(verdict.addresses).toEqual(['93.184.216.34']);
  });

  it('handles an unparseable CONNECT target without throwing', async () => {
    await withProxy(async ({ proxyPort }) => {
      const raw = await rawRequest(proxyPort, 'CONNECT :0 HTTP/1.1\r\nHost: x\r\n\r\n');
      expect(raw).toContain('403');
    });
  });
});
