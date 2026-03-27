# AGENTS.md

**Generated:** 2026-03-23
**Commit:** 006dd578

## OVERVIEW

Local-first AI agent execution environment. The repo is mid-migration from a single engine/daemon package to a control-plane architecture: typed API contract, execution runtimes, control-plane services, and platform-specific worlds. The local daemon still serves HTTP API + RPC + MCP, and the web app is now a TanStack Start control surface.

## STRUCTURE

```
executor/
├── apps/
│   ├── cli/          # CLI entrypoint + local daemon server
│   └── web/          # TanStack Start + Cloudflare Workers UI
├── packages/
│   ├── control-plane/       # Domain model, ports, service migration seam
│   ├── engine/              # Transitional runtime/services still backing control-plane
│   ├── execution/           # Runtime contract, IR, runtime implementations
│   ├── executor-api/        # Typed REST contract
│   ├── worlds/              # Local/cloudflare/testing world implementations
│   ├── integrations/        # MCP bridge, AI SDK integration
│   ├── sources/             # Source adapters (mcp, openapi, graphql, builtins…)
│   ├── kernel/core/         # Remaining shared kernel abstractions
│   └── clients/react/       # REST-based React hooks
└── tools/oxlint/            # Custom monorepo lint rules
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Control-plane types | `packages/control-plane/src/create-control-plane.ts` | Shared control-plane runtime types only |
| World contract | `packages/control-plane/src/world.ts` | Port surface for local/cloudflare/testing |
| Local daemon server | `apps/cli/src/server/` | `/discover`, `/health`, `/rpc`, `/mcp`, `/v1/*` |
| Local world implementation | `packages/worlds/local/src/` | Active local bootstrap + partially stubbed world ports |
| REST contract | `packages/executor-api/src/` | Shared types for HTTP clients |
| Web UI | `apps/web/src/` | TanStack Start routes, router, views |
| React client hooks | `packages/clients/react/src/` | REST hooks over the control-plane API |
| Source adapters | `packages/sources/*/src/` | MCP, OpenAPI, GraphQL, Google Discovery |
| Sandbox runtimes | `packages/execution/runtime-*/src/` | QuickJS, SES, Deno, Cloudflare stub |

## CONVENTIONS

- **Package imports**: Use `#schema`, `#domain`, `#api`, `#runtime` path aliases defined per package
- **Effect tag naming**: Use `Context.GenericTag<ServiceType>("@executor/ServiceName")` — never read tags directly (lint: `no-direct-effect-tag-read`)
- **No Effect.run in tests**: Use `@effect/vitest` test harness — lint: `no-effect-run-in-effect-vitest-tests`
- **No node:fs with Effect**: Keep Node.js `node:fs` separate from Effect imports — lint: `no-node-fs-with-effect-imports`
- **No raw Effect.fail**: Use `fail` utility from `@/errors`
- **Migration generation**: `bun run --filter=@executor/engine db:generate` after schema changes
- **Changesets**: Every PR needing release must add `bun run changeset` — PR without changeset = no release

## ANTI-PATTERNS (THIS PROJECT)

- Do NOT call `Effect.run*` inside vitest tests — use `Effect.annotationSchema` or `@effect/vitest`
- Do NOT use `node:fs` imports alongside Effect imports in the same file
- Do NOT read Effect tags directly — use `Layer.get()` or `Effect.serviceFunction()`
- Do NOT edit `apps/cli/package.json` by hand (Changesets owns versioning)

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

- `packages/engine/AGENTS.md` — Transitional engine runtime/services
- `packages/sources/AGENTS.md` — Source adapters domain
- `packages/kernel/AGENTS.md` — Remaining kernel abstractions
- `packages/clients/react/AGENTS.md` — React REST hooks
- `apps/cli/AGENTS.md` — CLI + local daemon
- `apps/web/AGENTS.md` — TanStack Start web UI
