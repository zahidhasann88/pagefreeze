# HTTP API

Base path: `/api/v1`. The machine-readable specification is
[`api/openapi.yaml`](../api/openapi.yaml), generated from the same zod schemas the server
validates with (`pnpm openapi` regenerates it; CI fails if it drifts).

## Conventions

**Authentication.** Either a session cookie (created by `POST /api/v1/auth/login`) or
`Authorization: Bearer <token>`. Everything under `/api/v1` requires one of the two except
the public share endpoints; `/healthz`, `/readyz` and `/metrics` are unauthenticated.

Mutating requests authenticated by a **session cookie** must also send
`X-CSRF-Token: <the value of the pagefreeze_csrf cookie>`. Bearer requests do not.

**Errors.** Always the same shape:

```json
{
  "error": {
    "code": "validation_error",
    "message": "Request validation failed",
    "details": [{ "path": "scheduleValue", "message": "\"nope\" is not a valid cron expression" }]
  }
}
```

| Status | `code`                      | Meaning                                                      |
| ------ | --------------------------- | ------------------------------------------------------------ |
| 400    | `bad_request`               | Malformed request (bad JSON, malformed path parameter)       |
| 400    | `bad_request`               | URL refused by the SSRF policy (message explains which rule) |
| 401    | `unauthorized`              | Missing or invalid credentials                               |
| 403    | `forbidden` / `csrf_failed` | Authenticated but not allowed / CSRF check failed            |
| 404    | `not_found`                 | Unknown id or route                                          |
| 409    | `conflict`                  | State conflict                                               |
| 413    | `payload_too_large`         | Body over `PAGEFREEZE_BODY_LIMIT`                            |
| 422    | `validation_error`          | zod validation failed; `details` lists fields                |
| 429    | `rate_limited`              | Login attempts or general rate limit                         |
| 500    | `internal`                  | Unexpected server error                                      |

**Pagination.** List endpoints take `limit` (default 20, max 200) and an opaque `cursor`,
and return:

```json
{ "data": [ … ], "nextCursor": "eyJ0aW1lIjoxNzA…", "hasMore": true }
```

Cursors are keyset-based (the sort key of the last row), so they stay correct while new
snapshots are written. Pass `nextCursor` as `cursor` to get the next page; `null` means the
end.

## Auth

| Method | Path                  | Notes                                                                                                                         |
| ------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/v1/auth/login`  | `{ username, password }` → session cookie + readable `pagefreeze_csrf` cookie. Rate limited to 10 attempts / 5 min / address. |
| `POST` | `/api/v1/auth/logout` | Deletes the session row, clears both cookies.                                                                                 |
| `GET`  | `/api/v1/auth/me`     | Current principal: `{ username, kind, csrfToken, permissions }`.                                                              |

### API tokens

| Method   | Path                  | Notes                                                                                           |
| -------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| `GET`    | `/api/v1/tokens`      | Metadata only: `id`, `name`, `prefix`, timestamps. Never the plaintext.                         |
| `POST`   | `/api/v1/tokens`      | `{ name, expiresInDays? }` → **201 with `token` shown exactly once**. Stored as a SHA-256 hash. |
| `DELETE` | `/api/v1/tokens/{id}` | Revokes. Idempotent-ish: a second revoke is 404.                                                |

## Monitors

| Method   | Path                                       | Notes                                                                                                                                                                                                                                                        |
| -------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`    | `/api/v1/monitors`                         | Dashboard summaries. Filters: `status` (`ok\|changed\|failing\|paused\|all`), `tag`, `q` (name or URL substring).                                                                                                                                            |
| `POST`   | `/api/v1/monitors`                         | Create. The URL is checked against the SSRF policy before anything is stored, so a bad destination is a 400 with the rule that refused it. Header/cookie **values** are encrypted and never echoed back; only `secrets.headerNames` / `secrets.cookieNames`. |
| `GET`    | `/api/v1/monitors/{id}`                    | Full monitor including the derived `scheduleCron`, `scheduleDescription`, `nextRunAt` and `status`.                                                                                                                                                          |
| `PATCH`  | `/api/v1/monitors/{id}`                    | Partial update. `scheduleKind` and `scheduleValue` must be sent together. Changing the schedule re-registers the pg-boss job.                                                                                                                                |
| `DELETE` | `/api/v1/monitors/{id}`                    | Cascades to snapshots, changes, artefacts and channel attachments.                                                                                                                                                                                           |
| `POST`   | `/api/v1/monitors/{id}/capture`            | **202** with `{ mode: "queued"\|"inline", jobId, monitorId, queuedAt }`. The snapshot appears afterwards; poll the snapshots list.                                                                                                                           |
| `POST`   | `/api/v1/monitors/{id}/pause` / `…/resume` | Removes / reinstates the schedule; history is kept.                                                                                                                                                                                                          |
| `POST`   | `/api/v1/monitors/preview`                 | Full capture-body validation, then one real capture **without storing anything**. Returns `screenshotBase64`, extracted text preview, timings and any SSRF-blocked subrequests.                                                                              |
| `GET`    | `/api/v1/monitors/{id}/snapshots`          | Snapshot list, newest first. Filter: `status` (`success\|failed\|all`).                                                                                                                                                                                      |
| `GET`    | `/api/v1/monitors/{id}/changes`            | Change list, newest first. Filter: `significant` (`true\|false\|all`). Diff bodies are omitted from lists.                                                                                                                                                   |

### Monitor fields

Create accepts (defaults in parentheses): `name`, `url`, `tags` (`[]`), `enabled` (`true`),
`scheduleKind` (`preset`) + `scheduleValue` (`24h`) or a cron expression, `devicePreset`
(`desktop`), `viewportWidth` (1280), `viewportHeight` (800), `fullPage` (`true`),
`waitStrategy` (`load`), `waitSelector`, `extraDelayMs` (0), `captureSelector`,
`ignoreSelectors` (`[]`), `userAgent`, `changeThreshold` (0.5), `detectText` (`true`),
`detectHtml` (`true`), `retentionDays`, `headers` (`{}`), `cookies` (`[]`), `channelIds`.

## Snapshots

| Method | Path                                | Notes                                                                                                                                                      |
| ------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/snapshots/{id}`            | Snapshot row, including hashes and `duplicateOf`.                                                                                                          |
| `GET`  | `/api/v1/snapshots/{id}/screenshot` | PNG. `Cache-Control: … immutable` — artefacts never change once written.                                                                                   |
| `GET`  | `/api/v1/snapshots/{id}/html`       | **`text/plain`** with `nosniff` and a `default-src 'none'; sandbox` CSP. Captured markup is third-party data and is never served as HTML from this origin. |
| `GET`  | `/api/v1/snapshots/{id}/text`       | Extracted visible text, same headers.                                                                                                                      |

## Changes

| Method | Path                              | Notes                                                                                                                                                                                                                                |
| ------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/api/v1/changes/{id}`            | Full change: diff stats, `regions` (bounding boxes in the newer screenshot's CSS pixels), `textDiff` (word changes + hunks + unified patch), `htmlDiff` (folded line blocks), `navigation` (newer/older ids), `shares`.              |
| `GET`  | `/api/v1/changes/{id}/diff-image` | Highlighted pixel-diff PNG. Only exists when pixels actually differed.                                                                                                                                                               |
| `GET`  | `/api/v1/compare?a=&b=`           | Compare any two snapshots of the same monitor, in either order (the server sorts chronologically). `store=false` (default) computes and returns without writing; `store=true` upserts a change row (one change per target snapshot). |

## Channels

| Method   | Path                         | Notes                                                                                                                                                                |
| -------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/v1/channels`           | All channels. Webhook configs come back as `{ url, hasSecret }` — the secret is never returned.                                                                      |
| `POST`   | `/api/v1/channels`           | `type` one of `webhook` (config: `url`, `secret`?), `slack` (config: `url`), `email` (config: `to[]`, `subject?`). Destinations are checked against the SSRF policy. |
| `PATCH`  | `/api/v1/channels/{id}`      | Rename, enable/disable, or replace the config.                                                                                                                       |
| `DELETE` | `/api/v1/channels/{id}`      |                                                                                                                                                                      |
| `POST`   | `/api/v1/channels/{id}/test` | Sends a `channel.test` event. Returns `{ ok, status, error, durationMs }`; the error string never contains the secret.                                               |

## Shares

| Method   | Path                                                     | Notes                                                                                                                                                       |
| -------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/v1/changes/{id}/share`                             | `{ expiresInHours? }` → `{ id, changeId, url, token, expiresAt }`. The token is hashed at rest; the URL exists only in this response and in the list below. |
| `GET`    | `/api/v1/changes/{id}/shares`                            | List with `viewCount` and `active`.                                                                                                                         |
| `DELETE` | `/api/v1/shares/{id}`                                    | Revoke.                                                                                                                                                     |
| `GET`    | `/api/v1/share/{token}`                                  | **Public.** The shared change plus token-scoped artefact URLs.                                                                                              |
| `GET`    | `/api/v1/share/{token}/screenshot/{before\|after\|diff}` | **Public.** PNG, `Cache-Control: no-store` so revocation is immediate.                                                                                      |
| `GET`    | `/api/v1/share/{token}/text/{before\|after}`             | **Public.** Extracted text as `text/plain`.                                                                                                                 |

A share grants access to exactly that change and nothing else; the rest of the API still
requires authentication. See [security.md](security.md#share-links) for the privacy
implications.

## Operational

| Method | Path                  | Auth | Notes                                                                                                                                  |
| ------ | --------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/healthz`            | none | Liveness: answers from the process alone. Also at `/api/v1/healthz`.                                                                   |
| `GET`  | `/readyz`             | none | Readiness: checks database, storage and (in non-`api` modes) that Chromium launches. 503 with a per-check breakdown when any fail.     |
| `GET`  | `/metrics`            | none | Prometheus text exposition.                                                                                                            |
| `GET`  | `/api/v1/system/info` | yes  | Version, runtime, database version/size, storage driver/bytes, capture configuration, retention, SSRF policy, counts, scheduler state. |

## Webhook payload

Delivered to webhook and (in adapted form) Slack channels:

```json
{
  "schema": "pagefreeze/v1",
  "event": {
    "type": "change.detected | capture.failed | capture.recovered | channel.test",
    "occurredAt": "2026-01-02T03:04:05.000Z",
    "monitor": { "id": "…", "name": "…", "url": "…", "tags": ["…"] },
    "change": {
      "changeId": "…",
      "pixelDiffPercent": 1.5,
      "sizeChanged": false,
      "significant": true,
      "summary": "…",
      "textAdded": 3,
      "textRemoved": 1,
      "htmlAdded": 5,
      "htmlRemoved": 2,
      "createdAt": "…"
    },
    "failure": null,
    "message": "…",
    "links": { "change": "…", "share": null }
  }
}
```

Headers: `Content-Type: application/json`, `User-Agent`, `X-Pagefreeze-Event`,
`X-Pagefreeze-Delivery` (a delivery id), `X-Pagefreeze-Timestamp` (unix seconds) and, when a
signing secret is configured, `X-Pagefreeze-Signature: sha256=<hex>` computed as
`HMAC_SHA256(secret, "<timestamp>.<body>")`.

Verifying on the receiving side (and rejecting replays):

```js
import crypto from 'node:crypto';

const timestamp = req.headers['x-pagefreeze-timestamp'];
const provided = req.headers['x-pagefreeze-signature']; // "sha256=<hex>"
const body = rawBody; // the exact bytes received

if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) reject(); // replay window
const expected =
  'sha256=' + crypto.createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) reject();
```

Payloads never contain monitor headers, cookies or signing secrets.
