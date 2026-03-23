# AGENTS.md

**Generated:** 2026-03-23
**Commit:** b07800bd

## OVERVIEW

Local-first AI agent execution environment. Agent runs TypeScript against a typed tool catalog (MCP, OpenAPI, GraphQL sources) in a sandboxed runtime (QuickJS default). Daemon serves HTTP API + MCP endpoint + React UI at `http://127.0.0.1:8788`.

## STRUCTURE

```
executor/
├── apps/
│   ├── executor/     # CLI entrypoint, daemon lifecycle commands
│   └── web/          # React 19 + Vite + TanStack Router UI
├── packages/
│   ├── platform/
│   │   ├── server/         # HTTP server: /v1 API + /mcp + static UI
│   │   └── control-plane/   # Core logic: sources, secrets, execution, persistence
│   ├── kernel/
│   │   ├── core/            # Tool abstractions, discovery, schemas
│   │   ├── ir/              # Intermediate representation (catalog, ids)
│   │   └── runtime-*/        # Sandbox runtimes (quickjs, ses, deno)
│   ├── sources/             # Source adapters (mcp, openapi, graphql, builtins…)
│   ├── hosts/               # MCP bridge, AI SDK integration
│   └── clients/react/       # React hooks
└── tools/oxlint/            # Custom monorepo lint rules
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Source management logic | `packages/platform/control-plane/src/runtime/sources/` | SourceStore, catalog sync, auth |
| Execution creation/resume | `packages/platform/control-plane/src/runtime/execution/` | ExecutionManager, pause/resume |
| DB schema + migrations | `packages/platform/control-plane/src/db/schema/` | Drizzle ORM, sqlite-vec |
| HTTP API layer | `packages/platform/control-plane/src/api/` | REST endpoints |
| Effect Layer composition | `packages/platform/control-plane/src/runtime/index.ts` | 5-tier runtime DAG |
| Web UI components | `apps/web/src/components/` | React, Tailwind v4 |
| Source adapters | `packages/sources/*/src/` | MCP, OpenAPI, GraphQL, Google Discovery |
| Sandbox runtimes | `packages/kernel/runtime-*/src/` | QuickJS (default), SES, Deno |

## CONVENTIONS

- **Package imports**: Use `#schema`, `#domain`, `#api`, `#runtime` path aliases defined per package
- **Effect tag naming**: Use `Context.GenericTag<ServiceType>("@executor/ServiceName")` — never read tags directly (lint: `no-direct-effect-tag-read`)
- **No Effect.run in tests**: Use `@effect/vitest` test harness — lint: `no-effect-run-in-effect-vitest-tests`
- **No node:fs with Effect**: Keep Node.js `node:fs` separate from Effect imports — lint: `no-node-fs-with-effect-imports`
- **No raw Effect.fail**: Use `fail` utility from `@/errors`
- **Migration generation**: `bun run --filter=@executor/control-plane db:generate` after schema changes
- **Changesets**: Every PR needing release must add `bun run changeset` — PR without changeset = no release

## ANTI-PATTERNS (THIS PROJECT)

- Do NOT call `Effect.run*` inside vitest tests — use `Effect.annotationSchema` or `@effect/vitest`
- Do NOT use `node:fs` imports alongside Effect imports in the same file
- Do NOT read Effect tags directly — use `Layer.get()` or `Effect.serviceFunction()`
- Do NOT edit `apps/executor/package.json` by hand (Changesets owns versioning)

## COMMANDS

```bash
bun install         # Install deps
bun dev             # All dev servers (turbo)
bun run test        # All tests
bun run lint        # oxlint --deny-warnings
bun run lint:fix    # Auto-fix
bun run typecheck   # Type-check all
bun run changeset   # Add changeset file
bun run trace:up    # Start Jaeger (docker)
```

## AGENTS.md LOCATIONS

- `packages/platform/control-plane/AGENTS.md` — Core business logic (Effect-TS, DB, runtime)
- `packages/sources/AGENTS.md` — Source adapters domain
- `packages/kernel/AGENTS.md` — Kernel abstractions and runtimes
- `apps/executor/AGENTS.md` — CLI entrypoint
- `apps/web/AGENTS.md` — React web UI
