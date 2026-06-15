import {
  ExecutionToolError,
  type ToolDiscoveryProvider,
  type ToolDiscoveryResult,
} from "@executor-js/sdk/core";
import { Effect } from "effect";

import type { ToolEmbedder } from "./embedder";
import type { VectorizeMatch, VectorizeStore } from "./vectorize";

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const toResult = (match: VectorizeMatch): ToolDiscoveryResult => {
  const description = asString(match.metadata?.description);
  return {
    path: asString(match.metadata?.path),
    name: asString(match.metadata?.name),
    description: description.length > 0 ? description : undefined,
    integration: asString(match.metadata?.integration),
    score: match.score,
  };
};

/**
 * A semantic `tools.search` backend: embed the query (Gemini), nearest-neighbour
 * query Vectorize within the tenant `namespace`, and map matches back to
 * `ToolDiscoveryResult` straight from the stored metadata (no per-tool describe
 * round-trip). Pagination slices the returned matches; Vectorize is queried for
 * `offset + limit` (clamped to its topK cap), so deep pagination past the cap
 * is out of scope for v1 (tool search rarely paginates far).
 *
 * `input.executor` is unused — results come from the index, not a live catalog
 * scan; `input.namespace` (the integration-prefix search filter) is also
 * ignored in v1.
 */
export const makeVectorizeToolDiscoveryProvider = (deps: {
  readonly embedder: ToolEmbedder;
  readonly store: VectorizeStore;
  readonly namespace: string;
}): ToolDiscoveryProvider => ({
  searchTools: ({ query, limit, offset }) =>
    Effect.gen(function* () {
      if (query.trim().length === 0) {
        return { items: [], total: 0, hasMore: false, nextOffset: null };
      }
      const vector = yield* deps.embedder.embedQuery(query);
      const matches = yield* deps.store.query({
        vector,
        namespace: deps.namespace,
        topK: offset + limit,
      });
      const ranked = matches
        .filter((match) => asString(match.metadata?.path).length > 0)
        .map(toResult);
      const total = ranked.length;
      const start = Math.min(Math.max(offset, 0), total);
      const items = ranked.slice(start, start + limit);
      const consumed = start + items.length;
      const hasMore = consumed < total;
      return { items, total, hasMore, nextOffset: hasMore ? consumed : null };
    }).pipe(
      Effect.mapError(
        (cause) => new ExecutionToolError({ message: "Vectorize tool search failed.", cause }),
      ),
    ),
});
