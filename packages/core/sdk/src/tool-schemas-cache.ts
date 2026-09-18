import { Schema } from "effect";

import { ToolSchemaEntry } from "./types";

// ---------------------------------------------------------------------------
// Connection schema aggregate cache.
//
// The bulk schema surface (`tools.schemas`) builds one aggregate per
// connection: every tool's input schema plus the `$defs` it references. That
// build reads the connection's tool rows and its whole definition set once,
// which is cheap per connection but wasteful per page.
//
// The aggregate is keyed by a caller-computed fingerprint over the
// connection's `tool_schema_manifest` rows, so it invalidates exactly when a
// tool, its schema, or the connection's definition set changes. The backend is
// the executor's `KeyValueStore` (a host KV namespace in production).
// ---------------------------------------------------------------------------

export const TOOL_SCHEMAS_CACHE_VERSION = "v1";

export const ToolSchemasCacheEntry = Schema.Struct({
  version: Schema.Literal(TOOL_SCHEMAS_CACHE_VERSION),
  fingerprint: Schema.String,
  entries: Schema.Array(ToolSchemaEntry),
});

export interface ToolSchemasCacheKeyInput {
  readonly integration: string;
  readonly owner: string;
  readonly connection: string;
  readonly includeBlocked: boolean;
  readonly fingerprint: string;
}

export const toolSchemasCacheKey = (input: ToolSchemasCacheKeyInput): string =>
  [
    "tool-schemas",
    TOOL_SCHEMAS_CACHE_VERSION,
    input.integration,
    input.owner,
    input.connection,
    input.includeBlocked ? "all" : "visible",
    input.fingerprint,
  ].join("/");
