# syntax=docker/dockerfile:1

# Pagefreeze — multi-stage build.
#
# Stage layout:
#   base     node + pnpm, shared by the build stages
#   deps     installs the full dependency tree (including dev, needed to compile)
#   build    compiles shared + server (tsc) and the web SPA (vite)
#   runtime  the official Playwright image, which already ships Chromium and every shared
#            library it needs, so the final layer does not have to install browser deps
#
# The runtime image contains production dependencies only, runs as a non-root user, and
# has a liveness healthcheck wired to /healthz.

ARG NODE_VERSION=20
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.64.0-noble

# --------------------------------------------------------------------------- base
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install --global pnpm@9.15.9
WORKDIR /app

# --------------------------------------------------------------------------- deps
FROM base AS deps
# A lockfile-only copy first: this layer is reused whenever source changes but the
# dependency set does not, which is the common case.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# -------------------------------------------------------------------------- build
FROM deps AS build
COPY tsconfig.base.json eslint.config.js .prettierrc.json ./
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/web packages/web

# The server resolves the SPA from ../web/dist relative to its own package directory.
RUN pnpm --filter @pagefreeze/shared build \
 && pnpm --filter @pagefreeze/server build \
 && pnpm --filter @pagefreeze/web build

# Trim to production dependencies for the runtime layer.
RUN pnpm --filter @pagefreeze/server --prod deploy /out

# ------------------------------------------------------------------------ runtime
FROM ${PLAYWRIGHT_IMAGE} AS runtime

# Chromium's own sandbox needs either user namespaces or a setuid helper, neither of which
# an unprivileged container has. The container is the isolation boundary instead; see
# docs/security.md for the trade-off and for how to re-enable it.
ENV PAGEFREEZE_DISABLE_CHROMIUM_SANDBOX=true \
    NODE_ENV=production \
    PAGEFREEZE_DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=8080 \
    HOST=0.0.0.0

WORKDIR /app

# Everything the process needs at runtime, and nothing else: no TypeScript sources, no
# devDependencies, no build cache.
COPY --from=build /out ./packages/server
COPY --from=build /app/packages/web/dist ./packages/web/dist

# A non-root owner for both the app and the data volume.
RUN groupadd --system --gid 10001 pagefreeze \
 && useradd --system --uid 10001 --gid pagefreeze --home-dir /app --shell /usr/sbin/nologin pagefreeze \
 && mkdir -p /data \
 && chown -R pagefreeze:pagefreeze /app /data

USER pagefreeze

EXPOSE 8080
VOLUME ["/data"]

# /healthz is a liveness probe: it answers from the process alone, so a database restart
# does not cause an orchestrator to kill a healthy container. Use /readyz for readiness.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/packages/server
CMD ["node", "dist/index.js"]
