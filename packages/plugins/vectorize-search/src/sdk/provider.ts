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

/** Narrow results to a search `namespace` (an integration/path prefix),
 *  mirroring the lexical provider's `matchesNamespace`. Applied to the fetched
 *  page, so it best-effort narrows within the topK window rather than across the
 *  whole index. */
const matchesNamespace = (result: ToolDiscoveryResult, namespace: string | undefined): boolean => {
  if (namespace === undefined) return true;
  const ns = namespace.trim().toLowerCase();
  if (ns.length === 0) return true;
  return (
    result.integration.toLowerCase().startsWith(ns) || result.path.toLowerCase().startsWith(ns)
  );
};

/**
 * A semantic `tools.search` backend: embed the query (Gemini), nearest-neighbour
 * query Vectorize within the tenant `namespace`, and map matches back to
 * `ToolDiscoveryResult` straight from the stored metadata (no per-tool describe
 * round-trip).
 *
 * Pagination uses probe-one-ahead: Vectorize is queried for `offset + limit + 1`
 * (clamped to its topK cap), and the extra item — if present — sets `hasMore`
 * without being shown, so the model can page even though Vectorize never reports
 * a true total. Deep pagination past the topK cap is out of scope for v1.
 *
 * `input.executor` is unused — results come from the index, not a live catalog
 * scan. `input.namespace` narrows the page to an integration/path prefix.
 */
export const makeVectorizeToolDiscoveryProvider = (deps: {
  readonly embedder: ToolEmbedder;
  readonly store: VectorizeStore;
  readonly namespace: string;
}): ToolDiscoveryProvider => ({
  searchTools: ({ query, namespace, limit, offset }) =>
    Effect.gen(function* () {
      if (query.trim().length === 0) {
        return { items: [], total: 0, hasMore: false, nextOffset: null };
      }
      const safeOffset = Math.max(offset, 0);
      const vector = yield* deps.embedder.embedQuery(query);
      // Probe one past the page so a "next" item is visible even though Vectorize
      // never reports a true total.
      const matches = yield* deps.store.query({
        vector,
        namespace: deps.namespace,
        topK: safeOffset + limit + 1,
      });
      const ranked = matches
        .filter((match) => asString(match.metadata?.path).length > 0)
        .map(toResult)
        .filter((result) => matchesNamespace(result, namespace));
      const start = Math.min(safeOffset, ranked.length);
      const items = ranked.slice(start, start + limit);
      const hasMore = ranked.length > start + items.length;
      return {
        items,
        total: ranked.length,
        hasMore,
        nextOffset: hasMore ? start + items.length : null,
      };
    }).pipe(
      Effect.mapError(
        (cause) => new ExecutionToolError({ message: "Vectorize tool search failed.", cause }),
      ),
    ),
});
