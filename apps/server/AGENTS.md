# @executor/server

Thin HTTP server wrapper. Owns server lifecycle and request routing. All business logic lives in engine.

## What this package owns

- **Server lifecycle** — creates and owns the Node `http.Server`, handles SIGINT/SIGTERM shutdown, writes pid file on startup, cleans it up on exit.
- **HTTP routing** — incoming requests are dispatched:
  - `/mcp` → MCP endpoint (MCP protocol)
  - `/v1/*` → REST API (HttpApiBuilder)
  - everything else → static UI assets
- **Static file serving** — serves files from `assetsDir`, supports SPA fallback to `index.html`, dev server proxy via `devServerUrl`.
- **OpenTelemetry setup** — reads env vars, builds tracing layer, prints search URL on startup.
- **Request/response bridging** — converts Node `IncomingMessage`/`ServerResponse` to/from Web `Request`/`Response`.

## What engine owns

Everything else:
- Runtime creation (`createEngineRuntime`)
- API layer and all route handlers (`createEngineApiLayer` + `HttpApiBuilder`)
- MCP handler factory (`createExecutorMcpRequestHandler`)
- Execution environment resolution
- Secret material resolution
- Database, catalog, program logic

## Key types

- `LocalExecutorServer` — returned by `createLocalExecutorServer`: holds runtime, port, host, baseUrl.
- `LocalExecutorRequestHandler` — lower-level: lets the caller own the HTTP server but use this package's routing and runtime.
- `StartLocalExecutorServerOptions` — config passed to both; covers port, host, data dir, UI options, resolvers.

## Entry points

- `createLocalExecutorServer` — builds server, returns runtime + address info.
- `runLocalExecutorServer` — same but also writes pid file and runs until SIGINT/SIGTERM.
- `createLocalExecutorRequestHandler` — runtime + routing without the HTTP server; useful for embedding.
