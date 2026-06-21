import { Effect, Schema } from "effect";

import { sha256Hex } from "./blob";
import { cacheKeyPayload } from "./cache-key";

// ---------------------------------------------------------------------------
// `tools.list` cache.
//
// The list surface is a full `tool` scan + `tool_policy` read on every call. The
// catalog only changes when a connection is (re)produced or removed, so the
// DB-derived, policy-filtered list is cached and invalidated by a content-derived
// revision rather than a TTL:
//   - catalogGen: combines the per-connection `toolset_revision` rows (below).
//   - policyGen:  combines the `tool_policy` rows.
// Static tools are unioned LIVE (never cached) and the `query` substring filter is
// applied post-cache, so distinct queries share one cached set.
// ---------------------------------------------------------------------------

export const TOOL_LIST_CACHE_PREFIX = "tool-list/";
export const TOOL_LIST_CACHE_VERSION = "v1";

/** plugin_storage coordinates for the per-connection toolset-revision rows that
 *  back the catalog generation. Owner-scoped like every other catalog row, and
 *  written inside the same transaction that rewrites the connection's tools. */
export const CATALOG_REVISION_PLUGIN_ID = "executor.catalog-revision";
export const CATALOG_REVISION_COLLECTION = "connection";

/** plugin_storage `key` for a connection's toolset-revision row. */
export const catalogRevisionStorageKey = (integration: string, connection: string): string =>
  `${integration}:${connection}`;

const ToolListItemAnnotations = Schema.Struct({
  requiresApproval: Schema.optional(Schema.Boolean),
  approvalDescription: Schema.optional(Schema.String),
  mayElicit: Schema.optional(Schema.Boolean),
});

/** The list-projection fields of a `Tool` (no input/output schema — the list
 *  never loads them). Branded id types are stored as plain strings and rebuilt
 *  with their `.make` constructors on read, so this needs no branded schemas. */
const ToolListItem = Schema.Struct({
  owner: Schema.String,
  integration: Schema.String,
  connection: Schema.String,
  name: Schema.String,
  pluginId: Schema.String,
  description: Schema.String,
  annotations: Schema.optional(ToolListItemAnnotations),
  static: Schema.optional(Schema.Boolean),
});
export type ToolListCacheItem = typeof ToolListItem.Type;

export const ToolListCacheEntry = Schema.Struct({
  version: Schema.Literal(TOOL_LIST_CACHE_VERSION),
  tools: Schema.Array(ToolListItem),
});

interface ToolListCacheKeyInput {
  readonly owner?: string;
  readonly integration?: string;
  readonly connection?: string;
  readonly includeBlocked: boolean;
  readonly catalogGen: string;
  readonly policyGen: string;
}

export const toolListCacheKey = (input: ToolListCacheKeyInput): Effect.Effect<string> =>
  sha256Hex(
    cacheKeyPayload({
      version: TOOL_LIST_CACHE_VERSION,
      owner: input.owner,
      integration: input.integration,
      connection: input.connection,
      includeBlocked: input.includeBlocked,
      catalogGen: input.catalogGen,
      policyGen: input.policyGen,
    }),
  ).pipe(Effect.map((hash) => `${TOOL_LIST_CACHE_PREFIX}${TOOL_LIST_CACHE_VERSION}/${hash}`));
