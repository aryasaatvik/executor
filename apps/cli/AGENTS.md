# Executor CLI / Daemon App

## What it is

Thin Bunli-based CLI shell over the executor runtime. The CLI drives the local HTTP daemon (control plane + MCP handler + optional web UI) and keeps the Effect-heavy engine/runtime code behind that boundary.

## Entry point

`apps/cli/bin/executor` -> `src/cli/main.ts` using Bunli.

## Daemon (`executor daemon ...`)

- `runLocalExecutorServer()` from `@executor/server`
- HTTP server on `localhost:idor` (default port 46789)
- Serves:
  - `/mcp` — MCP protocol handler
  - `/v1/*` — control plane REST API
  - `/` — optional bundled web UI assets
- Writes PID to `~/.executor/server.pid` and logs to `~/.executor/server.log`
- The internal `__local-server` path still exists for daemon bootstrap

## Commands

| Command | Description |
|---|---|
| `executor daemon start` | Ensure the daemon is running |
| `executor daemon stop` | Stop the daemon |
| `executor daemon restart` | Restart the daemon |
| `executor daemon status` | Show daemon status (PID, reachability, workspace) |
| `executor daemon debug bootstrap` | Run the daemon in the foreground |
| `executor daemon debug paths` | Print daemon path defaults |
| `executor daemon debug info` | Print low-level daemon debug information |
| `executor doctor` | Health check: server, process, database, web assets, Deno |
| `executor call [code]` | Execute code against the daemon; reads from `--file`, `--stdin`, or positional arg |
| `executor resume --execution-id` | Resume a paused execution |

## Daemon lifecycle

- `ensureServer()` checks reachability; spawns a background child process if not running
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
- `@executor/engine` — `createEngineClient`, `createEngineRuntime`, execution types
- `@executor/executor-mcp` — MCP request handler
- Bunli core + platform packages for command parsing, prompts, and terminal behavior
