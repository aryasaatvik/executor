import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { InternalError } from "@executor-js/api";

// ---------------------------------------------------------------------------
// HTTP surface for the Semantic search plugin: index + operator search/status.
//
// Routes are flat and plugin-id-prefixed (`/semantic-search/...`), matching the
// execution-history/graphql convention — the per-request executor is already
// owner-scoped at the host edge, so there is no `:scopeId` segment.
//
//   - reindex (POST) indexes the whole tool catalog for the scoped tenant
//     through the same index fingerprint/materialize/embed pipeline.
//   - search (GET) runs a live `tools.search` through the SAME provider the
//     engine uses, so the operator console sees what the agent would.
//   - status (GET) reports index population (vector fingerprints + lexical docs).
//
// `SemanticSearchError` on the extension flows through the typed channel and
// `capture` downgrades it to `InternalError`.
// ---------------------------------------------------------------------------

/** Result of an index run: counts for each category of tool processed. */
export const ReindexResponse = Schema.Struct({
  namespace: Schema.String,
  total: Schema.Number,
  reembedded: Schema.Number,
  unchanged: Schema.Number,
  removed: Schema.Number,
});

/** One live `tools.search` match (fused vector/lexical score; higher is better). */
export const SearchResultItem = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  integration: Schema.String,
  score: Schema.Number,
});

/** A page of live search results for the operator console. */
export const SearchResponse = Schema.Struct({
  namespace: Schema.String,
  query: Schema.String,
  items: Schema.Array(SearchResultItem),
});

/** URL query for the live search endpoint (`limit` arrives as a string). */
const SearchQuery = Schema.Struct({
  q: Schema.String,
  namespace: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
});

/** Operator index status — vector (fingerprint) + lexical document counts. */
export const StatusResponse = Schema.Struct({
  namespace: Schema.String,
  indexed: Schema.Number,
  lexical: Schema.NullOr(Schema.Number),
});

export type SearchResultItemType = typeof SearchResultItem.Type;
export type SearchResponseType = typeof SearchResponse.Type;
export type StatusResponseType = typeof StatusResponse.Type;

export const SemanticSearchGroup = HttpApiGroup.make("semanticSearch")
  .add(
    HttpApiEndpoint.post("reindex", "/semantic-search/reindex", {
      success: ReindexResponse,
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.get("search", "/semantic-search/search", {
      query: SearchQuery,
      success: SearchResponse,
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.get("status", "/semantic-search/status", {
      success: StatusResponse,
      error: InternalError,
    }),
  );
