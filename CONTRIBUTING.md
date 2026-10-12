# Contributing to Pagefreeze

Thanks for your interest! Pagefreeze is a self-hosted website change monitor:
Fastify + PostgreSQL + pg-boss + Playwright on the server, React + Vite on the
web, zod schemas shared between them. This guide gets you from clone to pull
request.

By participating in this project you agree to abide by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Prerequisites:

- **Node 20+** (see [.nvmrc](.nvmrc)) and **pnpm 9** (`corepack enable` works)
- **PostgreSQL 15+** — a local instance or Docker:
  ```bash
  docker run -d --name pagefreeze-pg -e POSTGRES_USER=pagefreeze \
    -e POSTGRES_PASSWORD=pagefreeze -e POSTGRES_DB=pagefreeze \
    -p 5432:5432 postgres:17
  ```
- **Chromium for Playwright**: `pnpm --filter @pagefreeze/server exec playwright install --with-deps chromium`

Then:

```bash
pnpm install
cp .env.example .env            # defaults work against the local Postgres above
pnpm migrate                    # applies SQL migrations
pnpm dev                        # API + web dev server (web on :5173, API on :3000)
```

Log in with the `PAGEFREEZE_ADMIN_PASSWORD` from your `.env`. Useful extras:

| Command             | What it does                                          |
| ------------------- | ----------------------------------------------------- |
| `pnpm dev:web`      | Vite dev server only (API must already run on :3000)  |
| `pnpm demo`         | Seeded demo: mutating fixture page + 2 monitors       |
| `pnpm seed`         | Seed sample data into your dev database               |
| `pnpm worker`       | Run the worker process separately (`PAGEFREEZE_MODE`) |
| `pnpm openapi`      | Regenerate `api/openapi.yaml` from the zod schemas    |
| `pnpm screenshots`  | Regenerate the README screenshots in `docs/images/`   |
| `docker compose up` | The full production-ish stack locally                 |

## Running checks

```bash
pnpm lint          # eslint (flat config)
pnpm format:check  # prettier
pnpm typecheck     # tsc across all packages
pnpm test          # all unit tests everywhere + server integration tests
pnpm test:e2e      # Playwright end-to-end (builds the web bundle first)
pnpm coverage      # server coverage report; thresholds enforced (80% lines)
```

Integration tests need a **separate** PostgreSQL database. Point
`DATABASE_URL_TEST` at it (default `postgres://pagefreeze:pagefreeze@127.0.0.1:5432/pagefreeze_test`).
Without a reachable database, integration tests skip themselves with a clear
message — CI always provides one, so a skip locally is fine but not in CI.

Run `pnpm lint`, `pnpm typecheck` and `pnpm test` before pushing; CI runs the
same plus coverage and a Docker build.

## Project layout

```
packages/
  shared/   zod schemas, types, cron parsing — used by server and web
  server/   Fastify API, capture engine, diff engine, jobs, storage
  web/      React SPA (built into packages/web/dist, served by the server)
api/        openapi.yaml (generated — do not edit by hand)
docs/       architecture, API, configuration, security docs
migrations/ plain-SQL migrations (packages/server/migrations)
```

A few rules the codebase follows strictly (see
[docs/architecture.md](docs/architecture.md) for the full picture):

- **SQL lives only in `packages/server/src/db/`** — hand-written, no ORM.
  New tables/columns get a plain-SQL migration (`pnpm --filter @pagefreeze/server exec node-pg-migrate create <name> --migration-filename-format utc`).
- **All inputs are validated with zod** at the API boundary; schemas live in
  `packages/shared` when both server and web need them.
- **Business code depends on interfaces** (`StorageProvider`, `BrowserLauncher`,
  `Clock`, `Notifier`) so tests can inject fakes.
- **Secrets are encrypted** with AES-256-GCM via `src/crypto/secrets.ts` and
  never logged or returned in plaintext.
- **Any URL the browser touches must pass the SSRF guard** (`src/capture/ssrf.ts`).
  If you add a fetch path, route it through the guard or justify why not in
  review.

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Make your change with tests. New behavior needs new tests; bug fixes need a
   regression test. Keep server coverage above the enforced thresholds.
3. Update docs when behavior changes: `docs/configuration.md` (new env vars),
   `docs/api.md` + `pnpm openapi` (API changes), `README.md` (user-visible
   features).
4. Add an entry to the `## [Unreleased]` section of [CHANGELOG.md](CHANGELOG.md).
5. Use [Conventional Commits](https://www.conventionalcommits.org/) —
   `feat:`, `fix:`, `docs:`, `test:`, `build:`, `chore:`. They drive the
   changelog story and make history readable.
6. Fill in the PR template and make sure CI is green.

Good first areas: notification channel types, wait strategies, dashboard
filters, docs, and test coverage.

## Reporting issues

- **Bugs**: use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml)
  and include logs (`PAGEFREEZE_LOG_LEVEL=debug`) plus your deployment method.
- **Feature requests**: use the
  [feature template](.github/ISSUE_TEMPLATE/feature_request.yml).
- **Security vulnerabilities**: do **not** open a public issue — follow
  [SECURITY.md](SECURITY.md).

## Releasing (maintainers)

1. Update the version in the three `package.json` files and the root one.
2. Move `## [Unreleased]` content to a new `## [x.y.z] - YYYY-MM-DD` section in
   the changelog and update the compare links.
3. Commit as `chore(release): vx.y.z`, tag `vx.y.z`, push the tag.
4. The release workflow builds multi-arch images, pushes them to
   `ghcr.io/<org>/pagefreeze` and creates the GitHub Release.
