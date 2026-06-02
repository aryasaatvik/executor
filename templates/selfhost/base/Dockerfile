# Self-hosted Executor — single container, no external services.
# Build context is THIS repo (the thin scaffold):
#   docker build -t executor-selfhost .
#
# Runtime needs nothing but this container + a volume for the data dir:
#   docker run -p 4788:4788 -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
#     -e EXECUTOR_BOOTSTRAP_ADMIN_EMAIL=you@example.com \
#     -e EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD=... \
#     -e EXECUTOR_WEB_BASE_URL=https://your.domain \
#     -v executor-data:/data executor-selfhost
#
# SQLite (libSQL, file:/data/...) lives in /data, QuickJS + MCP run in-process —
# so there's no postgres/worker/proxy to orchestrate.

# ── Build stage: install deps + build the SPA ──────────────────────────────
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json ./
# Lockfile is optional for the first build; copy it when present so installs are
# reproducible. (A wildcard COPY is a no-op when the file is absent.)
COPY bun.lock* ./
# Full install (dev deps included — vite + plugins are needed to build the SPA).
RUN bun install
COPY . .
# Builds the self-host SPA into ./dist (the shared @executor-js/app shell + this
# app's plugin client bundles, via vite).
RUN bun run build
# Reinstall PRODUCTION deps only, so the runtime image excludes the build/dev
# toolchain (vite, tailwind, the tanstack router plugin, typescript, ...). The
# built SPA lives in ./dist (outside node_modules), so it survives the reinstall.
RUN rm -rf node_modules && bun install --production

# ── Runtime stage: serve the built app under Bun ────────────────────────────
FROM oven/bun:1 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    EXECUTOR_HOST=0.0.0.0 \
    PORT=4788 \
    EXECUTOR_DATA_DIR=/data
COPY --from=build /app /app
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 4788
# Readiness probe against the public /api/health endpoint (a trivial DB ping).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD bun -e "fetch('http://127.0.0.1:4788/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# serve.ts binds the Effect AppLayer (API + /mcp + /api/auth + /docs) and serves
# the built SPA from ./dist — one process.
CMD ["bun", "run", "src/serve.ts"]
