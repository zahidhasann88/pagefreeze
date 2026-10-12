# Architecture

Pagefreeze is a pnpm monorepo with three packages and no runtime dependencies outside them:

```
packages/
  shared/    zod schemas, cron engine, shared types       (no runtime deps beyond zod)
  server/    Fastify API, capture engine, diff engine, jobs, notifications
  web/       React + Vite single-page app, served as static files by the server
```

The server and the web app both import `@pagefreeze/shared`, so the API contract — the zod
schemas that validate requests, the cron parser, the monitor/change/snapshot types — exists
in exactly one place. `api/openapi.yaml` is generated from those same schemas.

## Process modes

`PAGEFREEZE_MODE` selects what a process runs:

| Mode          | HTTP listener | Recurring scheduler/workers | Browser                                             |
| ------------- | ------------- | --------------------------- | --------------------------------------------------- |
| all (default) | yes           | yes                         | launched on demand                                  |
| api           | yes           | no                          | launched for manual captures/previews and readiness |
| worker        | no            | yes                         | launched on demand                                  |

Use one all process for the supported deployment. The api mode disables recurring jobs, but manual capture and preview routes still use Chromium. Separate API/worker deployments need additional schedule reconciliation when monitors are edited in the API process; horizontal scaling is not verified by this release.

## Request path

```
client ──▶ Fastify (security headers, body limit, rate limit)
        ──▶ auth preHandler (session cookie or bearer token; CSRF for cookie sessions)
        ──▶ route handler: parse with zod → queries (SQL) / storage / scheduler
        ──▶ uniform error shape on failure: { error: { code, message, details? } }
```

All SQL lives in `src/db/queries.ts`. Route handlers never compose SQL; they call typed
functions, so the storage shape is changeable in one place and transactions wrap
multi-row changes (a monitor plus its secrets row, a snapshot plus its change).

Migrations are plain SQL files under `packages/server/migrations/`, applied on start by
`node-pg-migrate` used purely as a runner. They can equally be applied with `psql -f`.

## Capture path

A capture is one job through the whole pipeline, in `src/capture/`:

1. **Guard the destination.** `SsrfGuard` validates the URL (scheme, hostname, every
   resolved address). See [security.md](security.md).
2. **Start a capture proxy.** `SsrfProxy` binds a loopback-only HTTP proxy; the browser
   context is pointed at it so the socket to the target is opened by Pagefreeze, to the
   validated address. This is what defeats DNS rebinding.
3. **Fresh browser context.** One shared Chromium instance, a new isolated context per
   capture (no cookies, storage or cache carried over), all permissions denied.
4. **Navigate and stabilise.** Wait per the monitor's strategy (`load`, `networkidle`, or a
   selector), remove the ignore-selector elements, freeze animations and transitions, scroll
   to trigger lazy loading, return to the top, apply any extra delay.
5. **Capture.** Screenshot (viewport or full page, or a single element), `page.content()`
   for the HTML, `document.body.innerText` for the visible text, plus title, final URL,
   status and timing.
6. **Hash and store.** SHA-256 over the screenshot, HTML and text. When all three match the
   previous snapshot, the snapshot row is written with `duplicate_of` pointing at it and its
   keys reused — **no new files are written and no diff is computed**.
7. **Compare.** Otherwise the previous successful snapshot is loaded from storage and the
   diff engine runs (in a worker thread by default).
8. **Record and notify.** A change row is written with pixel/text/HTML stats, region boxes
   and a significance flag; if significant, attached channels are notified.

Retries happen at step 6 level: transient failures (timeouts, navigation errors) are retried
with exponential backoff; SSRF-blocked and render failures are not, because retrying them
only creates load. Failed captures are stored as snapshots with `status = 'failed'` and an
error message, and **never** produce a change. After
`PAGEFREEZE_FAILURE_NOTIFY_THRESHOLD` consecutive failures a single notification goes out,
and one more when the monitor recovers.

## Scheduling

One pg-boss queue and one cron schedule per enabled monitor, plus a single retention queue.
`Scheduler.sync()` reconciles the queue against the `monitors` table — called on start and
after every monitor mutation — creating, updating or removing schedules so a paused or
deleted monitor stops running immediately. Each capture job carries
`singletonKey = <monitorId>`, which is what prevents double-running across instances.

The retention job deletes snapshots, changes and artefacts older than the per-monitor (or
global) retention window, always keeping each monitor's newest successful snapshot so a
quiet monitor never loses its baseline. A second pass deletes orphaned files — artefacts
left behind when a process died between writing a file and committing its row.

## Diff engine

`src/diff/` has four independent pieces, each unit-tested against generated fixtures:

- **`visual`** — pixelmatch over the two PNGs. Images of different sizes are compared on the
  larger canvas (the smaller one padded), and the size change is reported rather than
  hidden. Produces the percentage, the changed-pixel count and a highlighted PNG.
- **`regions`** — clusters changed pixels into bounding boxes by bucketing the change mask
  onto a coarse grid and flood-filling, so the cost tracks changed pixels rather than image
  area. Region boxes are what the UI overlays and lists.
- **`text`** — line and word level diffs via jsdiff over whitespace-normalised text, with a
  unified patch. Pure whitespace differences are normalised away before diffing.
- **`html`** — line diffs over _normalised_ HTML: scripts, styles, comments, doctype and head
  metadata removed; `nonce`, `style`, `srcset` and every `data-*` attribute dropped; the
  remaining attributes sorted per element; whitespace collapsed. Document order is preserved
  because order is meaningful. Unchanged runs are folded with three lines of context.

Inputs are capped (400k characters of text, 6000 normalised HTML lines) and the word-level
pass is skipped for very large inputs: jsdiff is quadratic in the worst case and an
unbounded input would be a denial of service against the diff worker. Hitting a cap sets
`truncated`, which the UI surfaces together with links to the raw files.

## Storage

`StorageProvider` is the single interface over artefact storage; `LocalStorageProvider` is
the only implementation, writing under `PAGEFREEZE_DATA_DIR`:

```
<data>/monitors/<monitorId>/snapshots/<snapshotId>/screenshot.png
<data>/monitors/<monitorId>/snapshots/<snapshotId>/page.html
<data>/monitors/<monitorId>/snapshots/<snapshotId>/page.txt
<data>/monitors/<monitorId>/changes/<changeId>/diff.png
```

Keys are validated against directory traversal. Because artefacts are content-addressed per
snapshot, duplicate captures reuse the previous snapshot's keys instead of storing a second
copy. An S3-compatible provider is a documented roadmap item; everything that touches
artefacts already goes through the interface.

## Notifications

`NotificationService` delivers events (`change.detected`, `capture.failed`,
`capture.recovered`, `channel.test`) to webhook, Slack-compatible and SMTP email channels.
Webhook payloads are generic JSON with `schema: "pagefreeze/v1"`, signed with
`X-Pagefreeze-Signature: sha256=<hmac(timestamp.body)>` and `X-Pagefreeze-Timestamp`, so a
receiver can verify provenance and reject replays. Destinations go through the SSRF guard
and do not follow redirects by default.

## Web app

React 18 + TanStack Query + React Router, plain CSS, no component library and **no external
assets** — the bundle contains every icon as inline SVG and every style inline, so the app
works on an isolated network with no CDN. Dark mode follows `prefers-color-scheme` with a
manual override. The change viewer is the centrepiece: four visual modes (side-by-side,
draggable slider, onion-skin blend, highlighted diff with region boxes), zoom and pan with
full keyboard support, plus word-level text and folded HTML diffs. Stored content is always
rendered as escaped text, never injected into the DOM.

## Observability

`GET /healthz` (liveness, process only), `GET /readyz` (database, storage and browser
checks; 503 when any fail) and `GET /metrics` (Prometheus text format:
`pagefreeze_captures_total{status}`, `pagefreeze_capture_duration_seconds`,
`pagefreeze_changes_total{significant}`, `pagefreeze_queue_depth{queue}`,
`pagefreeze_captures_in_flight`, `pagefreeze_monitors_total`, `pagefreeze_snapshots_total`,
`pagefreeze_storage_bytes`, `pagefreeze_process_uptime_seconds`).

Logs are structured JSON via pino with a redaction list covering headers, cookie values,
encrypted blobs and the secret key. Per-request logging is off by default: URLs and query
strings routinely carry sensitive values, and the app logs what matters explicitly.
