import {
  createServer,
  request as httpRequest,
  type Server,
  type ServerResponse,
  type IncomingMessage,
} from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { promises as dnsPromises } from 'node:dns';
import type { AddressInfo } from 'node:net';

/**
 * SSRF guard.
 *
 * Monitored URLs are fetched by a real browser, so every request a page makes - the
 * navigation, its redirect chain, subframes, XHR/fetch calls and subresources - is
 * untrusted input. The guard is applied in two layers:
 *
 *   1. `SsrfGuard.checkUrl()` / `checkConnect()` resolve the hostname themselves and
 *      reject the request when *any* resolved address is loopback, link-local, private,
 *      a cloud metadata address or otherwise unroutable. Every Playwright request is
 *      checked through `context.route()`, which covers redirects and subresources.
 *
 *   2. `SsrfProxy` is an in-process HTTP proxy that the capture browser is pointed at.
 *      It opens the socket to the exact IP address the guard validated, so a hostname
 *      that resolves to a public address during validation and to 127.0.0.1 a moment
 *      later (DNS rebinding) cannot be reached: the browser never resolves it itself.
 *
 * Note: Chromium bypasses proxies for hosts it considers loopback, so for loopback
 * targets layer 1 is the enforcement point. Both layers apply the same rules.
 */

export interface CheckResult {
  allowed: boolean;
  reason?: string;
  /** Validated addresses the connection may use, empty when blocked. */
  addresses: string[];
}

export const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'metadata.azure.com',
  'instance-data',
  'instance-data.ec2.internal',
  'nova',
  'metadata.internal',
]);

export const BLOCKED_HOSTNAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.localdomain',
  '.home.arpa',
];

const BLOCKED_V4: Array<[string, string]> = [
  ['0.0.0.0/8', 'this-network'],
  ['10.0.0.0/8', 'private-network'],
  ['100.64.0.0/10', 'carrier-grade-nat'],
  ['127.0.0.0/8', 'loopback'],
  ['169.254.0.0/16', 'link-local'],
  ['172.16.0.0/12', 'private-network'],
  ['192.0.0.0/24', 'ietf-protocol-assignments'],
  ['192.0.2.0/24', 'documentation'],
  ['192.88.99.0/24', '6to4-relay'],
  ['192.168.0.0/16', 'private-network'],
  ['198.18.0.0/15', 'benchmark'],
  ['198.51.100.0/24', 'documentation'],
  ['203.0.113.0/24', 'documentation'],
  ['224.0.0.0/4', 'multicast'],
  ['240.0.0.0/4', 'reserved'],
];

/**
 * Headers that belong to a single transport connection and must not be forwarded, in
 * either direction, by a proxy (RFC 9110 section 7.6.1).
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Addresses that deserve a more specific message than their containing range. */
const SPECIAL_V4 = new Map<string, string>([
  ['169.254.169.254', 'cloud-metadata'],
  ['169.254.170.2', 'cloud-metadata'],
  ['100.100.100.200', 'cloud-metadata'],
  ['192.0.0.192', 'cloud-metadata'],
]);

/* -------------------------------------------------------------------------- */
/* IPv4                                                                        */
/* -------------------------------------------------------------------------- */

export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return null;
    if (!/^\d+$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null; // reject leading zeros
    const n = Number.parseInt(part, 10);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

function cidrMatchV4(value: number, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const baseInt = ipv4ToInt(base ?? '');
  const bits = Number.parseInt(bitsRaw ?? '32', 10);
  if (baseInt === null || !Number.isFinite(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (baseInt & mask);
}

/* -------------------------------------------------------------------------- */
/* IPv6                                                                        */
/* -------------------------------------------------------------------------- */

/** Expands an IPv6 address into eight 16-bit groups. Returns null when unparseable. */
export function expandIpv6(ip: string): number[] | null {
  let text = ip.trim();

  const zoneIndex = text.indexOf('%');
  if (zoneIndex >= 0) text = text.slice(0, zoneIndex);
  if (text.length === 0 || text.length > 45) return null;

  const lastColon = text.lastIndexOf(':');
  if (lastColon < 0) return null; // no colon at all: not an IPv6 address

  // Rewrite an embedded IPv4 tail as the two hex groups it stands for, so the rest of the
  // parser only ever deals with `::` compression and hex groups. Slicing the tail off
  // instead would leave a dangling colon behind (`::127.0.0.1` -> `:`) and fail to parse.
  if (text.slice(lastColon + 1).includes('.')) {
    const intValue = ipv4ToInt(text.slice(lastColon + 1));
    if (intValue === null) return null;
    const high = ((intValue >>> 16) & 0xffff).toString(16);
    const low = (intValue & 0xffff).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const raw of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(raw)) return null;
      groups.push(Number.parseInt(raw, 16));
    }
    return groups;
  };

  const head = parseGroups(halves[0] ?? '');
  if (head === null) return null;
  const rest = halves.length === 2 ? parseGroups(halves[1] ?? '') : null;
  if (halves.length === 2 && rest === null) return null;

  let groups: number[];
  if (halves.length === 2) {
    const filler = 8 - head.length - (rest?.length ?? 0);
    if (filler < 0) return null;
    groups = [...head, ...new Array<number>(filler).fill(0), ...(rest ?? [])];
  } else {
    groups = head;
  }

  if (groups.length !== 8) return null;
  return groups;
}

export function classifyIpv6(groups: number[]): { blocked: true; reason: string } | null {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;

  if (groups.every((g) => g === 0)) return { blocked: true, reason: 'ipv6-unspecified' };
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0 &&
    g6 === 0 &&
    g7 === 1
  ) {
    return { blocked: true, reason: 'ipv6-loopback' };
  }

  if ((g0 & 0xfe00) === 0xfc00) return { blocked: true, reason: 'ipv6-unique-local' };
  if ((g0 & 0xffc0) === 0xfe80) return { blocked: true, reason: 'ipv6-link-local' };
  if ((g0 & 0xff00) === 0xff00) return { blocked: true, reason: 'ipv6-multicast' };
  if (g0 === 0x2001 && g1 === 0x0db8) return { blocked: true, reason: 'documentation' };
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) {
    return { blocked: true, reason: 'ipv6-discard' };
  }

  const v4FromTail = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0 || g5 === 0xffff)) {
    const verdict = classifyIpv4(v4FromTail);
    return verdict ? { blocked: true, reason: verdict.reason } : null;
  }

  if (g0 === 0x0064 && g1 === 0xff9b) {
    // 64:ff9b::/96 is the well-known NAT64 prefix: judge the embedded IPv4 address.
    if (g2 === 0 && g3 === 0 && g4 === 0) {
      const verdict = classifyIpv4(v4FromTail);
      return verdict ? { blocked: true, reason: verdict.reason } : null;
    }
    // 64:ff9b:1::/48 (RFC 8215) is local-use only and has no meaning for an outbound
    // capture, so block it rather than guessing at the embedded address.
    return { blocked: true, reason: 'nat64' };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Classification                                                              */
/* -------------------------------------------------------------------------- */

export function classifyIpv4(ip: string): { blocked: true; reason: string } | null {
  const special = SPECIAL_V4.get(ip);
  if (special) return { blocked: true, reason: special };

  const value = ipv4ToInt(ip);
  if (value === null) return { blocked: true, reason: 'unparseable-address' };

  for (const [cidr, reason] of BLOCKED_V4) {
    if (cidrMatchV4(value, cidr)) return { blocked: true, reason };
  }
  return null;
}

/** Classify a literal IP address. Returns `null` when the address is allowed. */
export function classifyIp(ip: string): { blocked: true; reason: string } | null {
  const trimmed = ip.trim();
  if (trimmed.includes(':')) {
    const groups = expandIpv6(trimmed);
    if (groups === null) return { blocked: true, reason: 'unparseable-address' };
    return classifyIpv6(groups);
  }
  return classifyIpv4(trimmed);
}

export function isBlockedHostname(hostname: string): string | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (host.length === 0) return 'empty-hostname';
  if (BLOCKED_HOSTNAMES.has(host)) return 'blocked-hostname';
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (host.endsWith(suffix)) return 'blocked-hostname';
  }
  // A decimal IPv4 literal such as http://2130706433/ is decoded by most HTTP clients.
  if (/^\d+$/.test(host)) return 'numeric-hostname';
  return null;
}

export interface Resolver {
  lookup(hostname: string): Promise<Array<{ address: string; family: number }>>;
}

export const systemResolver: Resolver = {
  async lookup(hostname: string) {
    try {
      const records = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
      return records.map((record) => ({ address: record.address, family: record.family }));
    } catch {
      return [];
    }
  },
};

export interface SsrfGuardOptions {
  allowPrivateTargets?: boolean;
  /**
   * Hosts (optionally `host:port`) that bypass the address range checks. Intended for
   * lab setups and for the bundled demo, which monitors a local fixture site. Every
   * other host, including redirect targets, is fully validated.
   */
  allowedHosts?: string[];
  resolver?: Resolver;
  cacheTtlMs?: number;
}

export class SsrfGuard {
  private readonly allowPrivateTargets: boolean;
  private readonly allowedHosts: Set<string>;
  private readonly resolver: Resolver;
  private readonly cache = new Map<string, { expiresAt: number; result: CheckResult }>();
  private readonly cacheTtlMs: number;

  constructor(options: SsrfGuardOptions = {}) {
    this.allowPrivateTargets = options.allowPrivateTargets ?? false;
    this.allowedHosts = new Set(
      (options.allowedHosts ?? []).map((entry) => entry.trim().toLowerCase()).filter(Boolean),
    );
    this.resolver = options.resolver ?? systemResolver;
    this.cacheTtlMs = options.cacheTtlMs ?? 30_000;
  }

  /** Check a full URL. Every scheme except http and https is rejected. */
  async checkUrl(rawUrl: string): Promise<CheckResult> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { allowed: false, reason: 'unparseable-url', addresses: [] };
    }
    return this.checkTarget(url.protocol, url.hostname, url.port);
  }

  /** Check a CONNECT target (`host:port`) seen by the capture proxy. */
  async checkConnect(hostPort: string): Promise<CheckResult> {
    const separator = hostPort.lastIndexOf(':');
    const host = separator >= 0 ? hostPort.slice(0, separator) : hostPort;
    const port = separator >= 0 ? hostPort.slice(separator + 1) : '443';
    const hostname = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    return this.checkTarget('https:', hostname, port);
  }

  private isAllowedHost(hostname: string, port: number): boolean {
    const host = hostname.toLowerCase();
    if (this.allowedHosts.size === 0) return false;
    if (this.allowedHosts.has(host)) return true;
    return this.allowedHosts.has(`${host}:${port}`);
  }

  private async checkTarget(
    protocol: string,
    rawHostname: string,
    port: string,
  ): Promise<CheckResult> {
    // `new URL()` keeps the brackets around an IPv6 literal ("[::1]"), and so does the
    // host part of a CONNECT target. Strip them before classifying the address.
    const hostname =
      rawHostname.startsWith('[') && rawHostname.endsWith(']')
        ? rawHostname.slice(1, -1)
        : rawHostname;

    if (protocol !== 'http:' && protocol !== 'https:') {
      return {
        allowed: false,
        reason: `scheme-not-allowed:${protocol.replace(':', '')}`,
        addresses: [],
      };
    }

    if (port && !/^\d+$/.test(port)) {
      return { allowed: false, reason: 'invalid-port', addresses: [] };
    }
    const fallbackPort = protocol === 'https:' ? 443 : 80;
    const portNumber = port ? Number.parseInt(port, 10) : fallbackPort;
    if (!Number.isFinite(portNumber) || portNumber < 1 || portNumber > 65535) {
      return { allowed: false, reason: 'invalid-port', addresses: [] };
    }

    const hostnameReason = isBlockedHostname(hostname);
    if (hostnameReason && !this.allowPrivateTargets && !this.isAllowedHost(hostname, portNumber)) {
      return { allowed: false, reason: hostnameReason, addresses: [] };
    }

    // Literal IP address: no DNS involved.
    if (ipv4ToInt(hostname) !== null || hostname.includes(':')) {
      const verdict = classifyIp(hostname);
      if (verdict && !this.allowPrivateTargets && !this.isAllowedHost(hostname, portNumber)) {
        return { allowed: false, reason: verdict.reason, addresses: [] };
      }
      return { allowed: true, addresses: [hostname] };
    }

    const cacheKey = `${hostname.toLowerCase()}:${portNumber}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    const records = await this.resolver.lookup(hostname.toLowerCase());
    if (records.length === 0) {
      const result: CheckResult = {
        allowed: false,
        reason: 'dns-resolution-failed',
        addresses: [],
      };
      this.cache.set(cacheKey, { expiresAt: Date.now() + this.cacheTtlMs, result });
      return result;
    }

    const addresses: string[] = [];
    for (const record of records) {
      const verdict = classifyIp(record.address);
      if (verdict && !this.allowPrivateTargets && !this.isAllowedHost(hostname, portNumber)) {
        const result: CheckResult = { allowed: false, reason: verdict.reason, addresses: [] };
        this.cache.set(cacheKey, { expiresAt: Date.now() + this.cacheTtlMs, result });
        return result;
      }
      addresses.push(record.address);
    }

    const result: CheckResult = { allowed: true, addresses };
    this.cache.set(cacheKey, { expiresAt: Date.now() + this.cacheTtlMs, result });
    return result;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* Capture proxy                                                              */
/* -------------------------------------------------------------------------- */

export interface SsrfProxyOptions {
  guard: SsrfGuard;
  /**
   * Idle timeout for a forwarded plain-HTTP request. Must be at least as long as the capture
   * timeout, otherwise a slow origin is cut off by the proxy and Chromium renders our 502 as
   * though the site had returned it - recording a "successful" capture of a page that never
   * loaded. Defaults to 120s.
   */
  upstreamTimeoutMs?: number;
  onBlocked?: (info: { target: string; reason: string }) => void;
  logger?: {
    debug: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
  };
}

function writeHeaders(
  socket: Socket | Duplex,
  statusLine: string,
  headers: Record<string, string>,
): void {
  let head = `${statusLine}\r\n`;
  for (const [key, value] of Object.entries(headers)) head += `${key}: ${value}\r\n`;
  head += '\r\n';
  socket.write(head);
}

/**
 * Loopback-only HTTP proxy used by the capture browser. Both the HTTP and the
 * HTTPS/CONNECT path open the upstream socket to an address the guard validated.
 */
export class SsrfProxy {
  private server: Server | null = null;
  private port = 0;

  constructor(private readonly options: SsrfProxyOptions) {}

  async start(): Promise<number> {
    const server = createServer((req, res) => {
      void this.handlePlainRequest(req, res);
    });
    server.on('connect', (req: IncomingMessage, clientSocket: Duplex, head: Buffer) => {
      void this.handleConnect(req, clientSocket, head);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return this.port;
  }

  getPort(): number {
    return this.port;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = 0;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }

  private block(clientSocket: Socket | Duplex | undefined, target: string, reason: string): void {
    this.options.onBlocked?.({ target, reason });
    this.options.logger?.debug({ target, reason }, 'ssrf: request blocked');
    try {
      if (clientSocket && !clientSocket.destroyed) {
        writeHeaders(clientSocket, 'HTTP/1.1 403 Forbidden', {
          'Content-Length': '0',
          Connection: 'close',
        });
        clientSocket.end();
      }
    } catch {
      // socket already gone
    }
  }

  private async handleConnect(
    req: IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const target = req.url ?? '';
    const verdict = await this.options.guard.checkConnect(target);
    if (!verdict.allowed || verdict.addresses.length === 0) {
      this.block(clientSocket, target, verdict.reason ?? 'blocked');
      return;
    }

    const separator = target.lastIndexOf(':');
    const port = separator >= 0 ? Number.parseInt(target.slice(separator + 1), 10) || 443 : 443;
    const address = verdict.addresses[0]!;

    const upstream = netConnect({ host: address, port }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    upstream.on('error', () => this.block(clientSocket, target, 'upstream-error'));
    clientSocket.on('error', () => upstream.destroy());
    clientSocket.on('close', () => upstream.destroy());
  }

  /**
   * Forward a plain HTTP request.
   *
   * Chromium sends absolute-form requests (`GET http://host/path`) to a proxy for http://
   * URLs, and uses CONNECT for https:// ones. The upstream socket is opened to the exact
   * IP address the guard validated - `host` is an IP literal, so Node performs no DNS
   * lookup of its own and a rebinding hostname cannot resolve to something else here.
   *
   * The response is parsed and re-emitted through the ServerResponse API rather than piped
   * as raw bytes: piping would make Node invent its own `200 OK` framing and hand the
   * browser a document whose body is the upstream status line and headers.
   */
  private async handlePlainRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = req.url ?? '';
    const target = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `http://${raw}`;
    const verdict = await this.options.guard.checkUrl(target);

    if (!verdict.allowed || verdict.addresses.length === 0) {
      this.options.onBlocked?.({ target, reason: verdict.reason ?? 'blocked' });
      if (!res.headersSent) {
        res.writeHead(403, { 'content-type': 'text/plain', 'content-length': '0' });
      }
      res.end();
      return;
    }

    let url: URL;
    try {
      url = new URL(target);
    } catch {
      this.options.onBlocked?.({ target, reason: 'unparseable-url' });
      if (!res.headersSent) {
        res.writeHead(400, { 'content-type': 'text/plain', 'content-length': '0' });
      }
      res.end();
      return;
    }

    const port = url.port ? Number.parseInt(url.port, 10) : 80;
    const address = verdict.addresses[0]!;

    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
      headers[key] = value;
    }
    headers['host'] = url.host;

    const upstreamRequest = httpRequest(
      {
        host: address,
        port,
        method: req.method ?? 'GET',
        path: `${url.pathname}${url.search}`,
        headers,
        // The address is already vetted. The timeout only exists to release a socket an
        // origin abandoned; it must stay above the capture timeout so the browser's own
        // deadline is what fires first.
        timeout: this.options.upstreamTimeoutMs ?? 120_000,
      },
      (upstreamResponse) => {
        const responseHeaders: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(upstreamResponse.headers)) {
          if (value === undefined) continue;
          if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
          responseHeaders[key] = value;
        }

        res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        upstreamResponse.pipe(res);
        upstreamResponse.on('error', () => res.end());
      },
    );

    upstreamRequest.on('timeout', () => upstreamRequest.destroy(new Error('upstream timeout')));
    upstreamRequest.on('error', (error: Error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain', 'content-length': '0' });
      }
      res.end();
      this.options.logger?.debug({ target, error: error.message }, 'ssrf: upstream error');
    });

    req.on('aborted', () => upstreamRequest.destroy());
    req.pipe(upstreamRequest);
  }
}
