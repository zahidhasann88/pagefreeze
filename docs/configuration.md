# Configuration reference

Every setting is an environment variable. There is no config file: containers and
orchestrators are better at secrets than files are.

Defaults below are what `loadConfig()` applies. `Required` means the process refuses to
start (in production, where noted) without it.

| Variable                    | Default                  | Required          | Description                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | ------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`              | —                        | yes               | PostgreSQL connection string. Must point at a database the process can create tables in; migrations run automatically on start.                                                                                                                                                                                                      |
| `PAGEFREEZE_SECRET_KEY`     | —                        | yes in production | AES-256-GCM key, **exactly 32 bytes, base64 encoded**. Encrypts monitor headers, cookies and webhook signing secrets at rest. Generate with `openssl rand -base64 32`. In development a key is generated once and written to `<PAGEFREEZE_DATA_DIR>/.dev-secret-key` so stored secrets survive restarts; production never does this. |
| `PAGEFREEZE_ADMIN_PASSWORD` | `pagefreeze` (dev only)  | yes in production | Password for the single admin account. In production the process refuses to start if this is empty or one of the known defaults (`changeme`, `change-me`, `password`, `admin`, `admin123`, `pagefreeze`, `secret`, `letmein`).                                                                                                       |
| `PAGEFREEZE_ADMIN_USERNAME` | `admin`                  |                   | Username for the admin account.                                                                                                                                                                                                                                                                                                      |
| `NODE_ENV`                  | `development`            |                   | `development`, `production` or `test`. Gates the strict startup checks and cookie flags.                                                                                                                                                                                                                                             |
| `PAGEFREEZE_MODE`           | `all`                    |                   | `all` (API + scheduler + workers), `api` (HTTP, previews/manual captures; no recurring jobs) or `worker` (scheduler + captures, no HTTP listener). See [architecture.md](architecture.md#process-modes).                                                                                                                             |
| `HOST`                      | `0.0.0.0`                |                   | Bind address.                                                                                                                                                                                                                                                                                                                        |
| `PORT`                      | `8080`                   |                   | HTTP port.                                                                                                                                                                                                                                                                                                                           |
| `PAGEFREEZE_BASE_URL`       | derived from the request |                   | Public base URL, used to build share links and the links inside notifications. Set this when behind a reverse proxy.                                                                                                                                                                                                                 |
| `PAGEFREEZE_DATA_DIR`       | `./data`                 |                   | Where screenshots, stored HTML and extracted text are written.                                                                                                                                                                                                                                                                       |
| `LOG_LEVEL`                 | `info`                   |                   | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`.                                                                                                                                                                                                                                                                      |
| `PAGEFREEZE_DB_POOL_MAX`    | `10`                     |                   | Connection pool size.                                                                                                                                                                                                                                                                                                                |
| `PAGEFREEZE_DB_SSL`         | `false`                  |                   | Enable TLS for the database connection.                                                                                                                                                                                                                                                                                              |
| `PAGEFREEZE_WEB_DIST`       | auto-detected            |                   | Override the directory the SPA is served from.                                                                                                                                                                                                                                                                                       |

## Capture

| Variable                              | Default    | Description                                                                                                                                                                                 |
| ------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAGEFREEZE_CAPTURE_CONCURRENCY`      | `2`        | Captures running at once. Chromium is heavy: 2 is comfortable on 4 GB of RAM, 4 on 8 GB. Queued captures wait rather than failing.                                                          |
| `PAGEFREEZE_CAPTURE_TIMEOUT_MS`       | `60000`    | Hard deadline for one capture, including navigation, stabilisation and screenshot.                                                                                                          |
| `PAGEFREEZE_CAPTURE_RETRIES`          | `2`        | Retries after a transient failure, with exponential backoff from `PAGEFREEZE_CAPTURE_RETRY_BASE_MS`. Blocked (SSRF) and render failures are not retried.                                    |
| `PAGEFREEZE_CAPTURE_RETRY_BASE_MS`    | `2000`     | Base for the backoff schedule: `base`, `base*2`, `base*4`, capped at 30s.                                                                                                                   |
| `PAGEFREEZE_BLOCK_MEDIA`              | `true`     | Abort `media` and `font` subresources during capture. Faster and far more stable screenshots; set `false` if you need to detect image changes.                                              |
| `PAGEFREEZE_BLOCK_THIRD_PARTY`        | `false`    | Reserved for a future stricter mode; currently accepted and unused.                                                                                                                         |
| `PAGEFREEZE_MAX_SCREENSHOT_BYTES`     | `26214400` | Refuse to store screenshots larger than this.                                                                                                                                               |
| `PAGEFREEZE_CHROMIUM_ARGS`            | —          | Extra space-separated Chromium flags.                                                                                                                                                       |
| `PAGEFREEZE_DISABLE_CHROMIUM_SANDBOX` | `false`    | Pass `--no-sandbox`. Needed in unprivileged containers where Chromium's sandbox cannot use user namespaces. The Docker image sets this; see [security.md](security.md#chromium-sandboxing). |

## Scheduling and failure handling

| Variable                              | Default | Description                                                                                                                      |
| ------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `PAGEFREEZE_MIN_INTERVAL_MINUTES`     | `15`    | Refuse to create or update a monitor whose schedule would run more often than this. `0` disables the check (the demo uses this). |
| `PAGEFREEZE_FAILURE_NOTIFY_THRESHOLD` | `3`     | Notify once when a monitor reaches this many consecutive capture failures, and once more when it recovers.                       |
| `PAGEFREEZE_RETENTION_INTERVAL_HOURS` | `12`    | Minimum interval between retention runs; checked hourly. The interval restarts with the process.                                 |

## Diffing

| Variable                          | Default | Description                                                                                                                         |
| --------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `PAGEFREEZE_DIFF_PIXEL_THRESHOLD` | `0.1`   | pixelmatch per-pixel colour distance (0–1). Lower means stricter.                                                                   |
| `PAGEFREEZE_DIFF_WORKER`          | `true`  | Run diffs in a worker thread so a large comparison never blocks the event loop. Set `false` to diff inline (useful when debugging). |
| `PAGEFREEZE_DIFF_REGION_PADDING`  | `12`    | Pixel distance within which changed clusters are merged into one region box.                                                        |
| `PAGEFREEZE_DIFF_REGION_MIN_AREA` | `24`    | Discard clusters smaller than this many changed pixels; they are almost always anti-aliasing noise.                                 |

## Security

| Variable                       | Default              | Description                                                                                                                                                                                                                                                |
| ------------------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALLOW_PRIVATE_TARGETS`        | `false`              | Permit capturing loopback, private, link-local and cloud-metadata addresses. **Leave false** unless you deliberately monitor internal services. See [security.md](security.md#ssrf-protection).                                                            |
| `PAGEFREEZE_ALLOWED_HOSTS`     | —                    | Comma-separated `host` or `host:port` entries exempted from the address-range check. Prefer this over `ALLOW_PRIVATE_TARGETS` when only specific internal hosts are needed; every other destination, including redirect targets, is still fully validated. |
| `PAGEFREEZE_SECURE_COOKIES`    | `true` in production | Set the `Secure` flag on session cookies and enable the HSTS header. Must be `true` whenever the instance is reachable over HTTPS.                                                                                                                         |
| `PAGEFREEZE_TRUST_PROXY`       | `false`              | Trust `X-Forwarded-*` headers. Enable only behind a reverse proxy you control; login rate limiting keys on the client address.                                                                                                                             |
| `PAGEFREEZE_CORS_ORIGIN`       | —                    | Accepted for forward compatibility; the SPA is same-origin so CORS is not used today.                                                                                                                                                                      |
| `PAGEFREEZE_BODY_LIMIT`        | `262144`             | Maximum request body size in bytes (256 KiB).                                                                                                                                                                                                              |
| `PAGEFREEZE_SESSION_TTL_HOURS` | `168`                | Session cookie lifetime (7 days).                                                                                                                                                                                                                          |

## Notifications

| Variable                           | Default                        | Description                                                                                                                                                                             |
| ---------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAGEFREEZE_WEBHOOK_TIMEOUT_MS`    | `10000`                        | Deadline for one webhook delivery.                                                                                                                                                      |
| `PAGEFREEZE_WEBHOOK_MAX_REDIRECTS` | `0`                            | Redirects a webhook delivery may follow. The default refuses all: a destination that 302s to an internal address would otherwise defeat the SSRF check performed on the configured URL. |
| `SMTP_HOST`                        | —                              | Enables email channels. Empty means email channels report a clear configuration error.                                                                                                  |
| `SMTP_PORT`                        | `587`                          |                                                                                                                                                                                         |
| `SMTP_SECURE`                      | `false`                        | Use implicit TLS (465) instead of STARTTLS.                                                                                                                                             |
| `SMTP_USER`                        | —                              |                                                                                                                                                                                         |
| `SMTP_PASS`                        | —                              |                                                                                                                                                                                         |
| `SMTP_FROM`                        | `Pagefreeze <pagefreeze@HOST>` | Envelope sender.                                                                                                                                                                        |

## Politeness

| Variable                | Default                                                           | Description                                                                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAGEFREEZE_USER_AGENT` | `Pagefreeze/0.1.0 (+https://github.com/zahidhasann88/pagefreeze)` | Sent on every capture unless a monitor overrides it. Identifying yourself is what lets a site operator contact you or block you cleanly; please keep something identifiable. |

## Lifecycle

| Variable                       | Default | Description                                                                                         |
| ------------------------------ | ------- | --------------------------------------------------------------------------------------------------- |
| `PAGEFREEZE_SHUTDOWN_GRACE_MS` | `30000` | Time given to in-flight captures and the queue to drain on SIGTERM/SIGINT before the process exits. |

## Testing-only

| Variable                        | Default                                                           | Description                                                                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL_TEST`             | `postgres://pagefreeze:pagefreeze@127.0.0.1:5432/pagefreeze_test` | Database used by the integration and e2e suites. It is wiped and re-migrated on every run. When unreachable, those suites skip themselves with an explanation instead of failing. |
| `E2E_PORT` / `E2E_FIXTURE_PORT` | `8092` / `8091`                                                   | Fixed ports for the e2e stack.                                                                                                                                                    |
| `E2E_PASSWORD`                  | `e2e-password-123`                                                | Admin password for the e2e stack.                                                                                                                                                 |
