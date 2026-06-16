import {
  ExecutionToolError,
  type ToolDiscoveryProvider,
  type ToolDiscoveryResult,
} from "@executor-js/sdk/core";
import { Effect } from "effect";

import type { ToolEmbedder } from "./embedder";
import type { VectorMatch, VectorStore } from "./store";

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const toResult = (match: VectorMatch): ToolDiscoveryResult => {
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
 * Pagination fetches the full topK window (Vectorize never reports a true total)
 * and slices it: `hasMore` means "the filtered window holds more than this page".
 * Fetching the whole window — rather than probing one item past the page — keeps
 * `hasMore` correct even when the `input.namespace` filter discards the item that
 * would otherwise have been the probe. Deep pagination past the topK cap is out
 * of scope for v1.
 *
 * `input.executor` is unused — results come from the index, not a live catalog
 * scan. `input.namespace` narrows the page to an integration/path prefix.
 */
export const makeVectorToolDiscoveryProvider = (deps: {
  readonly embedder: ToolEmbedder;
  readonly store: VectorStore;
  readonly namespace: string;
}): ToolDiscoveryProvider => ({
  searchTools: ({ query, namespace, limit, offset }) =>
    Effect.gen(function* () {
      if (query.trim().length === 0) {
        return { items: [], total: 0, hasMore: false, nextOffset: null };
      }
      const safeOffset = Math.max(offset, 0);
      const vector = yield* deps.embedder.embedQuery(query);
      // Fetch the whole topK window (not a tight probe) so the post-fetch
      // namespace filter can't drop the one item that signals hasMore.
      const matches = yield* deps.store.query({
        vector,
        namespace: deps.namespace,
        // Use the store's own cap — each backend (Vectorize, zvec, etc.)
        // declares its maximum via `maxTopK` on the VectorStore interface.
        topK: deps.store.maxTopK,
      });
      const mapped = matches
        .filter((match) => asString(match.metadata?.path).length > 0)
        .map(toResult)
        .filter((result) => matchesNamespace(result, namespace));
      // The facet chunker indexes a tool as several chunks (identity, input,
      // output, description), so one tool can surface as multiple matches.
      // Collapse to the best-scoring chunk per `path` before paginating —
      // otherwise a tool occupies several result slots and, on the hybrid path,
      // accrues inflated RRF weight from its repeated ranks.
      const bestByPath = new Map<string, ToolDiscoveryResult>();
      for (const result of mapped) {
        const prev = bestByPath.get(result.path);
        if (prev === undefined || result.score > prev.score) {
          bestByPath.set(result.path, result);
        }
      }
      const ranked = [...bestByPath.values()].sort((a, b) => b.score - a.score);
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
