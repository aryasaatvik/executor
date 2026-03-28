# Executor CLI / Daemon App

## What it is

Thin Bunli-based CLI shell plus the local daemon server. The daemon now lives in `apps/cli/src/server`, bootstraps `createLocalControlPlane()`, and still carries a hybrid REST + RPC + MCP boundary while control-plane migration is in progress.

## Entry point

`apps/cli/bin/executor` -> `src/cli/main.ts`

## Daemon (`executor daemon ...`)

- Local HTTP server in `src/server/index.ts`
- Default host/port from `src/server/config.ts` (`127.0.0.1:8788`)
- Serves:
  - `/discover`
  - `/health`
  - `/rpc`
  - `/mcp`
  - `/v1/*`
  - `/` static web assets when provided
- Writes PID to `~/.executor/server.pid` and logs to `~/.executor/server.log`
- The hidden `__local-server` command path still bootstraps the background daemon

## Commands

| Command | Description |
|---|---|
| `executor daemon start` | Ensure the daemon is running |
| `executor daemon stop` | Stop the daemon |
| `executor daemon restart` | Restart the daemon |
| `executor daemon status` | Show daemon status and reachability |
| `executor daemon debug bootstrap` | Run the daemon in the foreground |
| `executor daemon debug paths` | Print daemon path defaults |
| `executor daemon debug info` | Print low-level daemon debug information |
| `executor doctor` | Health check: server, process, database, web assets, Deno |
| `executor call [code]` | Execute code against the daemon |
| `executor resume --execution-id` | Resume a paused execution |

## Daemon lifecycle

- `ensureServer()` checks reachability via `/rpc` and spawns a detached `__local-server` process if needed
- `runLocalExecutorServer()` creates the request handler and Node HTTP server
- `createLocalExecutorRequestHandler()` wires REST, RPC, MCP, health, and discovery endpoints

## Current architecture notes

- REST uses `HttpApiBuilder` from `src/server/api/`
- RPC contract now lives in `@executor/rpc` and is re-exported from `src/server/rpc/contract.ts`
- MCP now uses `cp.installation` + `cp.runtimeLayer`
- This app is still the main bridge between the new control-plane packages and remaining engine-backed API/RPC pieces

## Key dependencies

- `@executor/core` — control-plane composition seam
- `@executor/rpc` — shared RPC contract used by the daemon and client package
- `@executor/world-local` — local control-plane bootstrap + local world services
- `@executor/engine` — transitional RPC handler and legacy API pieces
- `@executor/executor-mcp` — MCP request handler
