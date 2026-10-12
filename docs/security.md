# Security model

This document describes what Pagefreeze defends against, how, and where the remaining
rough edges are. It is the authoritative text; the README summarises it.

## Threat model

Pagefreeze is unusual in that it runs a real browser pointed at URLs an operator supplies.
That makes it, in the worst case, a general-purpose SSRF primitive sitting on your network.
Everything else follows from taking that seriously:

1. **The monitored URL is untrusted input.** So are the redirect targets it chooses, the
   subframes it embeds, the scripts it runs and every subresource it requests.
2. **Captured content is untrusted data.** Stored HTML, text and screenshots came from a
   third-party server and must never be treated as part of this application.
3. **Credentials flow through it.** Operators attach headers and cookies so Pagefreeze can
   read authenticated pages. Those credentials must not leak through the API, the logs or
   the database.

## SSRF protection

The guard is enforced at **request time, for every request the browser makes** — the
navigation, each hop of its redirect chain, subframes, XHR/fetch and subresources — not just
once when the monitor is created. Two layers:

### 1. Per-request validation (`SsrfGuard`)

Every URL is checked before a connection is opened:

- **Scheme**: only `http` and `https`. `file:`, `chrome:`, `data:`, `gopher:`,
  `javascript:`, `about:` and anything else are refused.
- **Hostname**: `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.localdomain`,
  `*.home.arpa` and the known cloud-metadata hostnames
  (`metadata.google.internal`, `metadata`, `instance-data`, …) are refused by name, before
  DNS. Bare decimal IPv4 literals (`http://2130706433/`) are refused too.
- **Resolved addresses**: the hostname is resolved by the guard and **every** returned
  address is checked. Blocked ranges:
  - loopback `127.0.0.0/8`, `::1`
  - private `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`
  - link-local `169.254.0.0/16`, `fe80::/10` — which includes the cloud metadata address
    `169.254.169.254`
  - cloud metadata specifics `100.100.100.200` (Alibaba), `192.0.0.192`
  - carrier-grade NAT `100.64.0.0/10`, documentation and benchmark ranges, multicast,
    reserved space, IPv6 ULA, IPv6-mapped and NAT64 forms of any of the above

  A hostname answering with _one_ public and _one_ private address is refused, which closes
  the common rebinding trick where the first lookup is clean.

- **Fail closed**: unresolvable hostnames and unparseable addresses are refused, never
  allowed.

Escapes hatch: `ALLOW_PRIVATE_TARGETS=true` disables the address-range checks (schemes and
fail-closed behaviour remain). `PAGEFREEZE_ALLOWED_HOSTS=host[:port],…` exempts exactly the
listed hosts — the right choice for the demo and for lab setups, because a redirect _away_
from an allowlisted host is still fully validated.

### 2. A capture proxy that pins the destination (`SsrfProxy`)

Validation alone is not enough against **DNS rebinding**: a hostname can resolve to a public
address during the check and to `127.0.0.1` when the browser connects a moment later. To
close that, each capture runs behind a loopback-only HTTP proxy. The proxy opens the socket
itself, to the exact address the guard validated, and Chromium is pointed at the proxy. The
browser therefore never resolves the hostname for the connection it actually uses, and a
rebinding answer cannot be reached.

The proxy also refuses absolute-form requests and `CONNECT` targets the guard rejects, and
forwards plain HTTP through a properly parsed upstream request (never raw bytes, which
would let a crafted response frame leak into the page).

### Outbound webhooks use the same guard

Notification destinations are operator-controlled input with exactly the same reach, so
`NotificationService` checks every webhook URL through `SsrfGuard` before delivering, and
refuses to follow redirects by default (`PAGEFREEZE_WEBHOOK_MAX_REDIRECTS=0`).

### Known limitation

Chromium bypasses proxies for hosts it considers loopback, so for a loopback _target_ the
first layer is the enforcement point. Both layers apply identical rules, so the outcome is
the same; the proxy exists to pin DNS for everything that is not loopback.

## Chromium hardening

Every capture gets a **fresh, isolated browser context** — no cookies, storage or cache are
shared between monitors or between captures of the same monitor. Contexts are closed after
each capture. Additionally:

- all sensitive permissions (geolocation, camera, microphone, notifications, MIDI,
  background sync, persistent storage) are denied;
- downloads are disabled;
- animations and transitions are frozen, which also removes a class of timing-dependent
  renders;
- a hard per-capture timeout and a concurrency limit bound the resources any one page can
  consume;
- a memory-backed `--disable-dev-shm-usage` keeps Chromium from exhausting `/dev/shm` in
  containers.

### Chromium sandboxing

Chromium's own sandbox needs either user namespaces or a setuid helper, neither of which an
unprivileged container has. The Docker image therefore runs with
`PAGEFREEZE_DISABLE_CHROMIUM_SANDBOX=true` and relies on the container as the isolation
boundary: a non-root user, no writable volume other than `/data`, no host networking.

If your host supports it, you can re-enable the sandbox and get defense in depth:

```console
docker run --security-opt seccomp=unconfined --cap-add=SYS_ADMIN ...
```

or run on a host with unprivileged user namespaces enabled and leave the flag off.

## Authentication

- **One admin account.** The password comes from `PAGEFREEZE_ADMIN_PASSWORD`; the process
  refuses to start in production when it is empty or a known default.
- **Sessions**: `POST /api/v1/auth/login` creates a row and sets an `httpOnly`,
  `SameSite=Lax` cookie (`Secure` when `PAGEFREEZE_SECURE_COOKIES`). Sessions are random
  256-bit tokens; only their SHA-256 hash is stored.
- **Login rate limiting**: 10 attempts per 5 minutes per client address
  (`@fastify/rate-limit`). In-memory by default, so with several API replicas each keeps its
  own counter — adequate as abuse deterrence, not a global limit.
- **CSRF**: mutating requests authenticated by a session cookie must carry the
  `X-CSRF-Token` header matching the session's token (double-submit; the token is also in a
  readable cookie so the SPA can echo it). `SameSite=Lax` is the first line of defence;
  this is the second. Bearer-token requests are exempt because a token is not an ambient
  credential.
- **API tokens**: created through `POST /api/v1/tokens`, shown exactly once, stored as
  SHA-256 hashes. A `pfz_…` prefix is kept in the clear so a UI can identify a token.

## Secrets at rest

Custom request headers, cookies and webhook signing secrets are encrypted with
**AES-256-GCM** using `PAGEFREEZE_SECRET_KEY`. The envelope is
`PFZ1 | iv(12) | tag(16) | ciphertext`, base64.

- Only the **names** of configured headers/cookies are stored in the clear, so the API can
  show _what_ is configured without decrypting anything. Values are never returned by any
  endpoint after creation.
- The redaction list in the logger covers `Authorization`-shaped fields, cookie values,
  encrypted blobs and the secret key itself, so a stray `logger.debug(settings)` cannot
  write a credential to disk.
- Authentication failures are constant-time and the same message for a wrong username and a
  wrong password, so response timing does not leak which half was correct.

### Key rotation — a documented limitation

There is no key identifier in the envelope and no re-encryption tooling, so rotating
`PAGEFREEZE_SECRET_KEY` makes existing stored secrets unreadable. The intended procedure
today is:

1. Set the new key in a maintenance window.
2. Re-enter every monitor's headers/cookies and every webhook signing secret (the UI shows
   which names are configured but never the values, by design).

This is tracked as a roadmap item. Until then, treat the key as a long-lived secret and
store it in your secrets manager.

## Stored content is third-party data

Screenshots, extracted text and normalised HTML came from someone else's server and may
contain anything, including markup crafted to attack a viewer. Therefore:

- stored HTML and text are served **only as `text/plain`**, with
  `X-Content-Type-Options: nosniff` and a `default-src 'none'; sandbox` CSP. They are never
  served as `text/html` from this origin;
- the UI renders them as escaped text. There is no `<iframe>` of stored content; a sandboxed
  iframe on a separate origin is the documented future approach if live rendering is ever
  added;
- artefacts are content-addressed by snapshot id under the data directory and reachable only
  through authenticated endpoints, or through share links (below).

## Share links

`POST /api/v1/changes/:id/share` creates an unguessable 256-bit token (only its SHA-256 hash
is stored), optionally expiring, revocable. Anyone holding the URL can read **that one
change** — both screenshots, the pixel diff, the extracted text and the change statistics —
without an account.

Privacy consequences to accept deliberately:

- If the monitored page sits behind authentication, the shared artefacts may include
  account-specific or personal data.
- The URL is a bearer credential: forwarding it forwards access. It also appears in access
  logs of anything between the recipient and the server.
- Views are counted but not attributed; there is no recipient identity.

Revoke from the change page, or `DELETE /api/v1/shares/:id`.

## Transport-level headers

Every response carries `Content-Security-Policy` (`default-src 'self'`, no `unsafe-inline`,
no `unsafe-eval`, `frame-ancestors 'none'`, `object-src 'none'`), `X-Content-Type-Options:
nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `Permissions-Policy`,
`Cross-Origin-Resource-Policy: same-origin` and `Cross-Origin-Opener-Policy: same-origin`.
Endpoints that serve captured content override the CSP with the stricter
`default-src 'none'; sandbox`, and the global hook will not clobber that override. `HSTS`
is added when `PAGEFREEZE_SECURE_COOKIES` is set.

## What Pagefreeze will not do for you

- It will not log into sites with interactive flows (captchas, 2FA, OAuth redirects). Only
  static header and cookie authentication is supported.
- It will not defeat bot protection, and trying to is both a terms-of-service problem and a
  cat-and-mouse you will lose. If a site blocks you, ask for permission or use its API.
- It does not provide multi-user access or per-user authorisation. There is one admin;
  share links are the (deliberately narrow) way to let someone else see a change.

Please check the terms of service and `robots.txt` of any site you monitor, keep the
default identifying User-Agent, and do not set an interval that amounts to a load test.

## Reporting vulnerabilities

See [SECURITY.md](../SECURITY.md) at the repository root.
