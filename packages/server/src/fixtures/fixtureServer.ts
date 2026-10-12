import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
export interface FixtureState {
  price: string;
  plans: string[];
  terms: string[];
  includeClock: boolean;
  includeBanner: boolean;
  bodyHeight: number;
  lazyImages: number;
  accent: string;
}

export const DEFAULT_STATE: FixtureState = {
  price: '$19',
  plans: ['Starter — $19/mo', 'Team — $49/mo', 'Enterprise — contact us'],
  terms: [
    'The service is provided as is, without warranty of any kind.',
    'You may cancel at any time; access continues to the end of the billing period.',
    'Usage beyond the fair-use policy may be throttled.',
  ],
  includeClock: true,
  includeBanner: true,
  bodyHeight: 0,
  lazyImages: 0,
  accent: '#2f6f4e',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderPage(
  state: FixtureState,
  meta: { requestCount: number; path: string },
): string {
  const clock = state.includeClock
    ? `<p id="clock" class="volatile">Last updated: ${new Date().toISOString()} (request #${meta.requestCount})</p>`
    : '';

  const banners = ['Free trial — no card needed', 'Spring sale ends soon', 'New: team seats'];
  const banner = state.includeBanner
    ? `<div id="banner" class="volatile">${escapeHtml(banners[meta.requestCount % banners.length] ?? '')}</div>`
    : '';

  const plans = state.plans
    .map((plan) => `        <li class="plan">${escapeHtml(plan)}</li>`)
    .join('\n');

  const terms = state.terms
    .map((line) => `        <p class="term">${escapeHtml(line)}</p>`)
    .join('\n');

  const lazy = Array.from({ length: state.lazyImages }, (_unused, index) => {
    const hue = (index * 47) % 360;
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'><rect width='320' height='180' fill='hsl(${hue},45%,60%)'/><text x='16' y='96' font-size='28' fill='white'>item ${index + 1}</text></svg>`;
    const encoded = Buffer.from(svg).toString('base64');
    return `      <img class="lazy" loading="lazy" width="320" height="180" alt="Example item ${index + 1}" src="data:image/svg+xml;base64,${encoded}" />`;
  }).join('\n');

  const spacer =
    state.bodyHeight > 0
      ? `      <div id="spacer" style="height:${state.bodyHeight}px"></div>`
      : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Acme Pricing</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 32px;
        font-family: sans-serif;
        color: #16211c;
        background: #ffffff;
      }
      header { border-bottom: 3px solid ${state.accent}; padding-bottom: 12px; margin-bottom: 20px; }
      h1 { margin: 0 0 4px 0; font-size: 32px; }
      .price { font-size: 56px; font-weight: 700; color: ${state.accent}; margin: 12px 0; }
      ul { padding-left: 20px; margin: 12px 0; }
      li.plan { font-size: 18px; margin: 6px 0; }
      .terms { margin-top: 24px; border-top: 1px solid #d8ded9; padding-top: 16px; }
      p.term { font-size: 15px; line-height: 1.5; margin: 8px 0; max-width: 640px; }
      .volatile { font-size: 13px; color: #6b7a70; }
      #banner { background: #fdf3d8; border: 1px solid #e2c98a; padding: 8px 12px; font-size: 14px; margin-bottom: 16px; }
      #ad-slot { border: 1px dashed #b9c2bb; padding: 10px; font-size: 12px; color: #8a948c; margin: 16px 0; }
      .gallery { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 20px; }
      footer { margin-top: 32px; font-size: 12px; color: #6b7a70; }
    </style>
  </head>
  <body>
    <div id="app">
      <header>
        <h1>Acme Cloud Pricing</h1>
        <p class="subtitle">Simple, per-seat pricing.</p>
      </header>
${banner}
      <div class="price" id="price">${escapeHtml(state.price)}</div>
${clock}
      <ul id="plans">
${plans}
      </ul>
      <div id="ad-slot">Advertisement slot — contents rotate and are not part of the product.</div>
      <section class="terms" id="terms">
        <h2>Terms</h2>
${terms}
      </section>
      <div class="gallery">
${lazy}
      </div>
${spacer}
      <footer>Acme Cloud &mdash; fixture page served by Pagefreeze.</footer>
    </div>
  </body>
</html>
`;
}
export interface FixtureServerOptions {
  port?: number;
  host?: string;
  initialState?: Partial<FixtureState>;
}

export class FixtureServer {
  private server: Server | null = null;
  private state: FixtureState = { ...DEFAULT_STATE };
  private requestCount = 0;
  private autoChangeTimer: NodeJS.Timeout | null = null;
  baseUrl = '';
  port = 0;

  constructor(private readonly options: FixtureServerOptions = {}) {
    if (options.initialState) this.state = { ...DEFAULT_STATE, ...options.initialState };
  }

  getState(): FixtureState {
    return { ...this.state };
  }

  setState(patch: Partial<FixtureState>): FixtureState {
    this.state = { ...this.state, ...patch };
    return this.getState();
  }

  reset(): void {
    this.state = { ...DEFAULT_STATE, ...(this.options.initialState ?? {}) };
    this.requestCount = 0;
  }

  async start(): Promise<{ baseUrl: string; port: number }> {
    const server = createServer((req, res) => this.handle(req, res));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? 0, this.options.host ?? '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const address = server.address() as AddressInfo;
    this.port = address.port;
    this.baseUrl = `http://${this.options.host ?? '127.0.0.1'}:${this.port}`;
    return { baseUrl: this.baseUrl, port: this.port };
  }

  startAutoChange(intervalMs = 4000): void {
    this.stopAutoChange();
    let tick = 0;
    this.autoChangeTimer = setInterval(() => {
      tick += 1;
      const prices = ['$19', '$21', '$19', '$24'];
      const termSets: string[][] = [
        DEFAULT_STATE.terms,
        [...DEFAULT_STATE.terms, 'Data is stored in the region you select at signup.'],
        [
          'The service is provided as is, without warranty of any kind.',
          'Refunds are issued within 14 days of a cancelled subscription.',
        ],
      ];
      this.state = {
        ...this.state,
        price: prices[tick % prices.length] ?? '$19',
        terms: termSets[tick % termSets.length] ?? DEFAULT_STATE.terms,
      };
    }, intervalMs);
    this.autoChangeTimer.unref?.();
  }

  stopAutoChange(): void {
    if (this.autoChangeTimer) clearInterval(this.autoChangeTimer);
    this.autoChangeTimer = null;
  }

  async stop(): Promise<void> {
    this.stopAutoChange();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    this.requestCount += 1;
    const url = new URL(req.url ?? '/', this.baseUrl || 'http://127.0.0.1');
    const path = url.pathname;

    const send = (status: number, body: string, contentType = 'text/html; charset=utf-8'): void => {
      res.writeHead(status, {
        'content-type': contentType,
        'cache-control': 'no-store',
        'content-length': String(Buffer.byteLength(body)),
      });
      res.end(body);
    };

    const redirect = (location: string, status = 302): void => {
      res.writeHead(status, { location, 'content-length': '0' });
      res.end();
    };

    switch (path) {
      case '/':
      case '/pricing':
        send(200, renderPage(this.state, { requestCount: this.requestCount, path }));
        return;

      case '/static':
        send(
          200,
          renderPage(
            { ...this.state, includeClock: false, includeBanner: false },
            { requestCount: 0, path },
          ),
        );
        return;

      case '/__state':
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            try {
              const patch = JSON.parse(
                Buffer.concat(chunks).toString('utf8') || '{}',
              ) as Partial<FixtureState>;
              send(200, JSON.stringify(this.setState(patch)), 'application/json');
            } catch (error) {
              send(400, JSON.stringify({ error: (error as Error).message }), 'application/json');
            }
          });
          return;
        }
        send(200, JSON.stringify(this.getState()), 'application/json');
        return;

      case '/__reset':
        this.reset();
        send(200, JSON.stringify({ ok: true }), 'application/json');
        return;

      case '/redirect-loopback': {
        const target = url.searchParams.get('to') ?? `http://127.0.0.1:${this.port}/private`;
        redirect(target);
        return;
      }

      case '/redirect-metadata':
        redirect(url.searchParams.get('to') ?? 'http://169.254.169.254/latest/meta-data/');
        return;

      case '/redirect-private':
        redirect(url.searchParams.get('to') ?? 'http://192.168.0.1/admin');
        return;

      case '/redirect-chain':
        redirect(`/redirect-metadata`);
        return;

      case '/private':
        send(
          200,
          '<!doctype html><html><body><h1 id="leak">PRIVATE CONTENT REACHED</h1></body></html>',
        );
        return;

      case '/subresource': {
        const target = url.searchParams.get('to') ?? 'http://169.254.169.254/latest/meta-data/';
        send(
          200,
          `<!doctype html><html><body><h1>Subresource test</h1>` +
            `<img id="probe" src="${escapeHtml(target)}" alt="" />` +
            `<script>fetch(${JSON.stringify(target)}).catch(function(){});</script>` +
            `</body></html>`,
        );
        return;
      }

      case '/slow': {
        const ms = Number.parseInt(url.searchParams.get('ms') ?? '90000', 10);
        const timer = setTimeout(
          () => send(200, '<!doctype html><html><body>slow</body></html>'),
          ms,
        );
        req.on('close', () => clearTimeout(timer));
        return;
      }

      case '/error':
        send(
          Number.parseInt(url.searchParams.get('status') ?? '500', 10),
          'server error',
          'text/plain',
        );
        return;

      case '/late-content': {
        const delayMs = Number.parseInt(url.searchParams.get('ms') ?? '1200', 10);
        send(
          200,
          `<!doctype html><html><body><h1>Late content</h1><div id="root"></div>` +
            `<script>setTimeout(function(){` +
            `var el=document.createElement('p');el.id='late';el.textContent='Loaded after ${delayMs}ms';` +
            `document.getElementById('root').appendChild(el);}, ${delayMs});</script>` +
            `</body></html>`,
        );
        return;
      }

      case '/health':
        send(200, JSON.stringify({ ok: true, requests: this.requestCount }), 'application/json');
        return;

      default:
        send(404, '<!doctype html><html><body><h1>Not found</h1></body></html>');
        return;
    }
  }
}
