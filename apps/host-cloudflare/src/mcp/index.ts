import type { Layer } from "effect";

import type { McpAuthProvider, McpErrorReporter, McpSessionStore } from "@executor-js/host-mcp";

import type { ServiceTokenAliasLookup } from "../auth/service-token-alias";
import type { CloudflareConfig, CloudflareEnv } from "../config";
import { cloudflareAccessMcpAuth } from "./auth";
import { cloudflareMcpReporter, makeCloudflareMcpSessionStore } from "./session-store";

export { cloudflareAccessMcpAuth } from "./auth";
export { cloudflareMcpReporter, makeCloudflareMcpSessionStore } from "./session-store";
export { McpSessionDO } from "./session-durable-object";

// ---------------------------------------------------------------------------
// The Cloudflare MCP serving seams, fed to `ExecutorApp.make`'s `mcp` group.
//
// `ExecutorApp.make` mounts the shared, provider-neutral MCP serving envelope
// (@executor-js/host-mcp) at the top-level `/mcp`, outside the API's execution
// middleware. The Cloudflare host provides the two envelope seams plus the
// error-reporter override:
//   - McpAuthProvider  -> `cloudflareAccessMcpAuth`: validate the Access JWT
//                         (same identity as the API gate); no MCP OAuth.
//   - McpSessionStore  -> the shared Durable-Object dispatcher over the host's
//                         `MCP_SESSION` namespace (cross-isolate, same as cloud).
//   - McpErrorReporter -> `cloudflareMcpReporter`: route 500 defects through the
//                         host's console capture.
// ---------------------------------------------------------------------------

export interface CloudflareMcpSeams {
  /** Validate the Access JWT to an MCP `AuthOutcome`; declares no discovery routes. */
  readonly auth: Layer.Layer<McpAuthProvider>;
  /** The Durable-Object session store seam (dispatch + lifetime). */
  readonly sessions: Layer.Layer<McpSessionStore>;
  /** Route 500 defects through the host's console `ErrorCapture`. */
  readonly reporter: Layer.Layer<McpErrorReporter>;
}

/**
 * Build the Cloudflare MCP serving seams over the host's `MCP_SESSION` Durable
 * Object namespace. No per-session DB handle is threaded here — each session DO
 * opens its own D1 handle in its own isolate. The `/mcp` GATE auth runs in the
 * Worker (not the DO), so it takes the app-level service-token alias lookup so a
 * service-token MCP client resolves its aliased identity just like the API gate.
 */
export const makeCloudflareMcpSeams = (
  config: CloudflareConfig,
  env: CloudflareEnv,
  aliasLookup?: ServiceTokenAliasLookup,
): CloudflareMcpSeams => ({
  auth: cloudflareAccessMcpAuth(config, aliasLookup),
  sessions: makeCloudflareMcpSessionStore(env),
  reporter: cloudflareMcpReporter,
});
