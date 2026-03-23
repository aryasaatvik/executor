# control-plane

Core business logic runtime for executor, built on Effect-TS.

## What makes this package unique

- **Effect-TS Layer composition**: All services are wired via a 5-tier `Layer` DAG. Services declare explicit tier dependencies, enforced at compile time via `Effect`/`Layer`. No global singletons.
- **Two SQLite databases**: The control-plane store (auth, sessions, executions) lives in a Bun SQLite database managed by Drizzle ORM. The workspace catalog database is a separate per-workspace SQLite file with its own migration, FTS5, and optional sqlite-vec setup.
- **Durable execution**: `ExecutionService` persists tool-call steps and interaction state to the control-plane DB. On replay, steps are verified against stored paths/args. Suspended executions survive process restarts.
- **Source management pipeline**: Sources are discovered, adapted (MCP), authenticated, cataloged, and synced through a layered service pipeline. Each stage (store, auth material, sync, auth) is a separate Layer tier.
- **OpenTelemetry**: Tracing is propagated through execution runs via `ToolInvocationContext` (runId, executionSessionId, actor, callId, executionStepSequence).

## 5-Tier Layer Composition (`runtime/index.ts`)

| Tier | Services |
|------|----------|
| 1 — Foundation | `ControlPlaneStore`, `RuntimeLocalWorkspace`, `ExecutionManager` |
| 2 — Filesystem | `NodeFileSystem`, `LocalStorage`, `LocalToolRuntimeLoader` |
| 3 — Storage | `WorkspaceDatabase`, `SecretMaterialStore`, `SourceStore`, `CatalogStore` |
| 4 — Source | `SourceAuthMaterial`, `CatalogSync`, `SourceAuth` |
| 5 — Execution | `ExecutionEnvironmentResolver` |

Tier N may only depend on tiers 1..N-1.

## Service Tags

| Tag | Location | Purpose |
|-----|----------|---------|
| `ControlPlaneStore` | `runtime/store.ts` | In-memory effect-row access to control-plane DB (auth, sessions, executions) |
| `WorkspaceDatabase` | `local/workspace-database.ts` | Per-workspace SQLite file: provides write/query layers + `provideWrite`/`provideQuery` helpers |
| `RuntimeLocalWorkspace` | `local/runtime-context.ts` | Workspace ID, account ID, resolved config |
| `ExecutionManager` | `execution/live.ts` | Live execution state machine + pub/sub |
| `ExecutionEnvironmentResolver` | `execution/workspace/environment.ts` | Resolves `executor + toolInvoker + catalog` per workspace/account |
| `RuntimeSourceStore` | `sources/source-store.ts` | Source CRUD |
| `RuntimeSourceCatalogStore` | `catalog/source/runtime.ts` | Tool catalog per source |
| `RuntimeSourceAuthService` | `sources/source-auth-service.ts` | OAuth + credential flows |
| `RuntimeSourceAuthMaterial` | `auth/source-auth-material.ts` | Derived auth credentials |
| `RuntimeSourceCatalogSync` | `catalog/source/sync.ts` | Catalog reconciliation |

## DB Schema (`src/db/schema/`)

SQL files (Drizzle ORM + `@effect/sql-sqlite-bun`):
`account`, `auth-session`, `auth`, `catalog-document`, `catalog-tool`, `execution`, `oauth`, `policy`, `secret`, `source`, `source-catalog`, `workspace-state`

Catalog schema lives in the workspace SQLite, not here.

## API (`src/api/`)

- `api.ts` — Effect-TS `ControlPlaneApiRuntimeContext` tag
- `executions/` — Create, get, list, resume, step listing, session close
- `oauth/` — OAuth grant flows
- `policies/` — Policy evaluation
- `sources/` — Source CRUD and credential management
- `local/` — Local installation context and OAuth callback

## Key Programs (`runtime/programs/`)

- `catalog/` — Catalog programs (e.g., `catalog-type-signature.ts`)
- `execution/` — Execution orchestration programs
- `source/` — Source programs (e.g., `store.ts`)

## SQLite Workspace Database Seam

`WorkspaceDatabase` (`local/workspace-database.ts`) is the seam. It provides `writeLayer`/`queryLayer`/`provideWrite`/`provideQuery`. The write layer runs migrations, FTS5 setup, optional JSON→SQLite import, and sqlite-vec initialization. The query layer skips migration and JSON import, just opening the connection.

Catalog tool content lives in the workspace DB. Auth/session/execution state lives in the control-plane DB.

## OpenTelemetry Integration

`ToolInvocationContext` carries: `runId`, `executionSessionId`, `actor`, `callId`, `executionStepSequence`. These are propagated through `createExecution` → `createReplayToolInvoker` → `withExecutionInvocationContext` on each tool call.
