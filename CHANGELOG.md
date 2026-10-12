# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-12

Initial release.

### Added

- **Monitors**: watch any URL on a schedule (15m / 1h / 6h / 24h / 7d presets or
  arbitrary cron expressions), with viewport and device presets, full-page capture,
  wait strategies (`load`, `networkidle`, selector + extra delay), capture
  selectors, ignore selectors, custom user agent, custom headers and cookies
  (encrypted at rest), change threshold (default 0.5%), text and HTML change
  detection toggles, tags, pause/resume, and on-demand capture.
- **Capture engine**: shared headless Chromium with a fresh isolated browser
  context per capture, 60s hard timeout, configurable concurrency (default 2),
  animation stabilization, auto-scroll for lazy-loaded images, optional blocking
  of media/fonts, retries with backoff (default 2), and consecutive-failure
  alerts (3 failures, once) plus recovery notifications.
- **SSRF protection**: every browser request — including redirects, subframes
  and subresources — goes through a validating proxy that blocks loopback,
  private, link-local and cloud-metadata addresses (including IPv6 forms and
  DNS rebinding) unless `ALLOW_PRIVATE_TARGETS` is set; non-HTTP(S) schemes are
  rejected.
- **Diff engine**: pixelmatch-based visual diff with configurable threshold and
  anti-aliasing detection, clustered changed-region boxes, diff image and
  percentage; word-level text diff and line-level diff on normalized HTML;
  identical captures are deduplicated (files reused, no change recorded);
  diffs run in a worker thread.
- **Scheduling**: one pg-boss recurring job per enabled monitor with singleton
  keys, updated on monitor mutations; separate `api` and `worker` process modes;
  graceful shutdown; snapshot retention per monitor or global default (90 days),
  always keeping the newest snapshot, plus orphan file cleanup.
- **Notifications**: webhook channels with HMAC signing
  (`X-Pagefreeze-Signature: sha256=<hex>` over `timestamp.body`),
  Slack-compatible incoming webhooks, and SMTP email; channels attach to
  monitors and fire on change, failure and recovery events.
- **REST API** (`/api/v1`): session auth (login/logout/me), API tokens
  (shown once, stored hashed), monitors, snapshots (screenshot/HTML/text),
  changes (with diff image), arbitrary snapshot comparison, channels (+ test),
  shareable public change links (unguessable, expiring, revocable), health and
  readiness endpoints, Prometheus metrics; cursor pagination and a consistent
  error envelope throughout.
- **Web UI**: dashboard with status cards, thumbnails and change sparklines;
  monitor editor with live cron validation and human-readable description and a
  "Test capture now" preview; monitor detail with timeline, settings and
  notification tabs; change viewer with side-by-side, draggable slider,
  onion-skin and highlighted-diff visual modes, zoom/pan, region boxes,
  word-level text diff and collapsible HTML diff; compare screen; settings for
  tokens, channels, retention and system info; dark mode via
  `prefers-color-scheme`; accessible, self-contained (no CDN assets).
- **Security**: admin password from environment (hashed with scrypt; refused in
  production if default/empty), httpOnly + SameSite=Lax + Secure session
  cookies, CSRF protection, login rate limiting, AES-256-GCM encryption of
  monitor and channel secrets (`PAGEFREEZE_SECRET_KEY`), HTML always rendered
  escaped, zod validation of every input, body size limits, CSP and security
  headers, non-root browser in Docker.
- **Operations**: multi-stage Dockerfile based on the Playwright image
  (non-root, healthcheck), docker-compose with PostgreSQL, `.env.example`,
  Makefile, plain-SQL migrations (node-pg-migrate), OpenAPI spec generated
  from the zod schemas (`api/openapi.yaml`).
- **Tests**: server unit and integration tests (real PostgreSQL, real
  Playwright against a local fixture server), React Testing Library component
  tests, and a Playwright end-to-end flow (login → create monitor → capture →
  view change); ≥80% server coverage enforced in CI.

[Unreleased]: https://github.com/zahidhasann88/pagefreeze/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/zahidhasann88/pagefreeze/releases/tag/v0.1.0
