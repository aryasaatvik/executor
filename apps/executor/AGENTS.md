# Executor CLI / Daemon App

## What it is

Thin CLI shell over the executor runtime. Exposes a local HTTP daemon (control plane + MCP handler + optional web UI) and commands to drive it.

## Entry point

`apps/executor/bin/executor` -> `src/cli/main.ts` using `@effect/cli`.

## Daemon (`executor server start` / `executor up`)

- `runLocalExecutorServer()` from `@executor/server`
- HTTP server on `localhost:idor` (default port 46789)
- Serves:
  - `/mcp` — MCP protocol handler
  - `/v1/*` — control plane REST API
  - `/` — optional bundled web UI assets
- Writes PID to `~/.executor/server.pid` and logs to `~/.executor/server.log`
- Auto-starts on `up` or `call` if not already running (spawns `__local-server` internally)

## Commands

| Command | Description |
|---|---|
| `executor up` | Ensure daemon is running; auto-starts if absent |
| `executor down` | Stop the daemon |
| `executor status` | Show daemon status (PID, reachability, workspace) |
| `executor doctor` | Health check: server, process, database, web assets, Deno |
| `executor sandbox` | Check Deno sandbox availability |
| `executor call [code]` | Execute code against the daemon; reads from `--file`, `--stdin`, or positional arg |
| `executor resume --execution-id` | Resume a paused execution |
| `executor server start` | Explicitly start the daemon (foreground) |
| `executor dev seed-*` | Seed demo/GitHub sources into the workspace (dev helpers) |

## Daemon lifecycle

- `ensureServer()` checks reachability; spawns background child process if not running
- `startServerInBackground()` forks `bun src/cli/main.ts __local-server --port N` detached
- PID file records `pid`, `port`, `host`, `baseUrl`, `startedAt`, `logFile`

## Code execution flow (`call`)

1. Resolve code from args / file / stdin
2. `ensureServer()` — start daemon if needed
3. `client.executions.create()` — submit code to control plane
4. `driveExecution()` — poll for `waiting_for_interaction`, prompt user or open URL, call `executions.resume()` until settled
5. Print result (JSON or `completed`/`failed`)

## Key dependencies

- `@executor/server` — `runLocalExecutorServer`, server config constants
- `@executor/control-plane` — `createControlPlaneClient`, `createControlPlaneRuntime`, execution types
- `@executor/executor-mcp` — MCP request handler
- `@effect/cli`, `@effect/platform`, `@effect/platform-node` — CLI framework and Node runtime
