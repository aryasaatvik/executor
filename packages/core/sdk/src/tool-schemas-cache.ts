import { Schema } from "effect";

import { ToolSchemaEntry } from "./types";

// ---------------------------------------------------------------------------
// Connection schema aggregate cache.
//
// The bulk schema surface (`tools.schemas`) builds one aggregate per
// connection: every tool's input schema, the `$defs` it references, and the
// policy id it resolves against. That build reads the connection's tool rows
// and its whole definition set once, which is cheap per connection but
// wasteful per page.
//
// Two deliberate omissions from the cached shape:
//
//   - Policy is NOT baked in. `policyId` rides along and the caller filters at
//     read time, so a mutable plugin `toolPolicyProvider` (toolkit scopes) or a
//     new `tool_policy` row always wins over a cached aggregate. Caching a
//     policy-filtered set would serve a schema the agent-facing surface is
//     expected to hide.
//   - Projected schemas are NOT cached at all: `projectToolSchema` is reserved
//     for read-time presentation data, so `tools.schemas` bypasses the cache
//     whenever an active runtime declares it.
//
// The aggregate is keyed by a caller-computed fingerprint over the
// connection's `tool_schema_manifest` rows, so it invalidates exactly when a
// tool, its schema, or the connection's definition set changes.
// ---------------------------------------------------------------------------

export const TOOL_SCHEMAS_CACHE_VERSION = "v2";

export const CachedToolSchemaEntry = Schema.Struct({
  ...ToolSchemaEntry.fields,
  /** `normalizedPolicyId` for the tool; policy is resolved at read time. */
  policyId: Schema.String,
});
export type CachedToolSchemaEntry = typeof CachedToolSchemaEntry.Type;

export const ToolSchemasCacheEntry = Schema.Struct({
  version: Schema.Literal(TOOL_SCHEMAS_CACHE_VERSION),
  fingerprint: Schema.String,
  entries: Schema.Array(CachedToolSchemaEntry),
});

export interface ToolSchemasCacheKeyInput {
  readonly integration: string;
  readonly owner: string;
  readonly connection: string;
  readonly fingerprint: string;
}

export const toolSchemasCacheKey = (input: ToolSchemasCacheKeyInput): string =>
  [
    "tool-schemas",
    TOOL_SCHEMAS_CACHE_VERSION,
    input.integration,
    input.owner,
    input.connection,
    input.fingerprint,
  ].join("/");
