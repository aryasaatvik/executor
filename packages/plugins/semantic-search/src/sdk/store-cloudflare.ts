import { Effect } from "effect";

import { SemanticSearchError } from "./errors";
import type { VectorInput, VectorMatches, VectorStore } from "./store";

/** Minimal structural view of a Cloudflare Vectorize binding (the subset this
 *  plugin uses). A real `Vectorize` / `VectorizeIndex` binding from
 *  `@cloudflare/workers-types` satisfies it structurally, so the plugin stays
 *  free of the Workers global type lib — the same approach the metrics plugin
 *  takes for the Analytics Engine binding. */
export interface VectorizeIndex {
  query(
    vector: readonly number[],
    options?: {
      readonly topK?: number;
      readonly namespace?: string;
      readonly returnMetadata?: boolean | "all" | "indexed" | "none";
      readonly returnValues?: boolean;
    },
  ): Promise<VectorMatches>;
  upsert(vectors: readonly VectorInput[]): Promise<unknown>;
  deleteByIds(ids: readonly string[]): Promise<unknown>;
}

/** Vectorize caps `topK` at 100 (without metadata). With `returnMetadata:"all"`
 *  the effective cap is 20 — enforced separately by `withCloudflareLimits`. */
export const MAX_TOP_K = 100;

/** Vectorize caps `topK` at 20 when `returnMetadata:"all"` is set. This is the
 *  per-store cap exposed on the `VectorStore` interface for Cloudflare. */
export const MAX_METADATA_TOP_K = 20;

/** Vectorize caps a single upsert at ~1000 vectors / ~2 MB. At 1536-d a few
 *  dozen vectors already approach the size cap, so chunk conservatively well
 *  under both limits and upsert the batches sequentially. */
const UPSERT_BATCH_SIZE = 50;

const chunk = <A>(items: readonly A[], size: number): readonly (readonly A[])[] => {
  const safe = Math.max(1, Math.floor(size));
  const out: A[][] = [];
  for (let i = 0; i < items.length; i += safe) {
    out.push(items.slice(i, i + safe));
  }
  return out;
};

/** Effect-wrapped `VectorStore` backed by a Cloudflare Vectorize binding.
 *  `maxTopK` reflects the `returnMetadata:"all"` cap (20). */
export const makeVectorizeStore = (index: VectorizeIndex): VectorStore => ({
  maxTopK: MAX_METADATA_TOP_K,
  query: ({ vector, namespace, topK }) =>
    Effect.tryPromise({
      try: () =>
        index.query([...vector], {
          topK: Math.min(Math.max(1, topK), MAX_TOP_K),
          namespace,
          returnMetadata: "all",
        }),
      catch: (cause) => new SemanticSearchError({ message: "Vectorize query failed.", cause }),
    }).pipe(Effect.map((result) => result.matches)),
  upsert: (vectors) =>
    vectors.length === 0
      ? Effect.void
      : Effect.forEach(
          chunk([...vectors], UPSERT_BATCH_SIZE),
          (batch) =>
            Effect.tryPromise({
              try: () => index.upsert(batch),
              catch: (cause) =>
                new SemanticSearchError({ message: "Vectorize upsert failed.", cause }),
            }),
          { concurrency: 1, discard: true },
        ),
  deleteByIds: (ids) =>
    ids.length === 0
      ? Effect.void
      : Effect.tryPromise({
          try: () => index.deleteByIds([...ids]),
          catch: (cause) => new SemanticSearchError({ message: "Vectorize delete failed.", cause }),
        }).pipe(Effect.asVoid),
});
