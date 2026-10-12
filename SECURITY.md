# Security Policy

Pagefreeze fetches arbitrary URLs with a real browser and stores what it sees,
so we take security seriously. This document explains how to report
vulnerabilities and what we consider in scope.

## Supported versions

| Version | Supported                              |
| ------- | -------------------------------------- |
| 0.x     | :white_check_mark: (latest minor only) |
| < 0.x   | :x:                                    |

While the major version is 0, only the latest minor release receives security
fixes. Upgrade promptly; breaking changes between minors are documented in
[CHANGELOG.md](CHANGELOG.md).

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, use one of:

1. **GitHub private vulnerability reporting** (preferred): on the repository,
   go to the _Security_ tab → _Report a vulnerability_.
2. Email the maintainers at jahidhasann67@gmail.com.

Please include:

- Steps to reproduce (proof-of-concept code, curl commands, or configuration)
- The affected version(s) and deployment method (Docker, bare metal)
- Impact: what an attacker can achieve and any prerequisites
- Whether the vulnerability is already public

We aim to acknowledge reports within **3 business days** and to provide a fix
or mitigation guidance within **14 days** for confirmed high-severity issues.
You will be credited in the release notes unless you prefer to stay anonymous.
Please give us a reasonable chance to fix before disclosing publicly
(90 days is the norm).

## What we consider in scope

- **SSRF**: anything that makes the capture engine request loopback, private,
  link-local or cloud-metadata addresses when `ALLOW_PRIVATE_TARGETS` is off —
  including via redirects, subframes, subresources, DNS rebinding, or unusual
  URL/IP encodings (IPv6 forms, decimal/octal IPs, NAT64).
- **Authentication bypass**: reaching authenticated API endpoints or the UI
  without a valid session or token; CSRF; session fixation.
- **Secret exposure**: monitor headers/cookies, channel secrets, tokens or the
  admin password leaking via the API, logs, metrics, error messages, the
  database (unencrypted at rest), or stored files.
- **Stored XSS / HTML injection**: captured HTML being rendered rather than
  escaped anywhere in the UI or exports.
- **Path traversal**: reading or writing outside `PAGEFREEZE_DATA_DIR` via
  snapshot, diff or share endpoints.
- **Privilege escalation in the container**: escaping the non-root user,
  writable sensitive paths.
- **Injection**: SQL injection (we use parameterized queries everywhere),
  command injection, header injection into webhook/email notifications.

## Out of scope

- Attacks that require an existing authenticated admin session (admins can by
  design monitor any allowed URL and read their own captured data).
- Physical access attacks or attacks on the host OS.
- Vulnerabilities in third-party services you connect (Slack, SMTP relays).
- Misconfigurations documented as operator responsibility — e.g. running with
  `ALLOW_PRIVATE_TARGETS=true`, a weak `PAGEFREEZE_SECRET_KEY`, or exposing the
  app to the public internet without TLS. See
  [docs/security.md](docs/security.md) for the threat model and hardening
  guide.
- Reports from automated scanners without a working proof of concept.

## Security hardening overview

The full model is in [docs/security.md](docs/security.md). Highlights:

- Every browser request is routed through an SSRF-validating proxy that pins
  the resolved IP for the connection (rebinding-safe).
- Secrets are encrypted with AES-256-GCM (32-byte base64
  `PAGEFREEZE_SECRET_KEY`); only names are ever returned by the API.
- Admin password is provided via environment, hashed with scrypt, and refused
  in production if default or empty.
- Sessions use httpOnly, SameSite=Lax, Secure cookies; state-changing requests
  require a CSRF header; login is rate-limited.
- API tokens are stored as SHA-256 hashes and shown exactly once.
- Captured HTML is stored and displayed escaped; a strict CSP (no
  `unsafe-inline` for scripts) is applied.
- In Docker the app and browser run as a non-root user.
