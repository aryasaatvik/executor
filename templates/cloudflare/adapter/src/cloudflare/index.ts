// ---------------------------------------------------------------------------
// Vendored @executor-js/cloudflare adapter — barrel re-export.
//
// This is your OWNED copy of the shared Cloudflare MCP host adapter (the
// upstream package is unpublished, so the cloudflare-adapter registry block
// vendors its source here under src/cloudflare/**). The base template's
// tsconfig.json `paths` and vite.config.ts `resolve.alias` map the
// `@executor-js/cloudflare` package specifiers onto these files, so the
// scaffolded MCP glue (src/mcp/*) imports them by package name with no rewrite.
//
// The named subpaths mirror the upstream package's `exports` map:
//   @executor-js/cloudflare/mcp/worker-transport -> ./mcp/worker-transport
//   @executor-js/cloudflare/mcp/do-headers       -> ./mcp/do-headers
//   @executor-js/cloudflare/mcp/response-peek     -> ./mcp/response-peek
//   @executor-js/cloudflare/mcp/session-store     -> ./mcp/session-store
//   @executor-js/cloudflare/mcp/durable-object    -> ./mcp/session-durable-object
// ---------------------------------------------------------------------------

export * from "./mcp/worker-transport";
export * from "./mcp/do-headers";
export * from "./mcp/response-peek";
export * from "./mcp/session-store";
export * from "./mcp/session-durable-object";
