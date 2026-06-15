import { Effect } from "effect";

import { VectorizeSearchError } from "./errors";

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
  ): Promise<VectorizeMatches>;
  upsert(vectors: readonly VectorizeVectorInput[]): Promise<unknown>;
  deleteByIds(ids: readonly string[]): Promise<unknown>;
}

export interface VectorizeMatches {
  readonly matches: readonly VectorizeMatch[];
  readonly count?: number;
}

export interface VectorizeMatch {
  readonly id: string;
  readonly score: number;
  readonly namespace?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface VectorizeVectorInput {
  readonly id: string;
  readonly values: readonly number[];
  readonly namespace?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Vectorize caps `topK` at 100 (with metadata). The provider fetches this full
 *  window and paginates within it, so the store clamps any request to it. */
export const MAX_TOP_K = 100;

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

/** Effect-wrapped, plugin-facing view over a Vectorize binding. */
export interface VectorizeStore {
  readonly query: (input: {
    readonly vector: readonly number[];
    readonly namespace: string;
    readonly topK: number;
  }) => Effect.Effect<readonly VectorizeMatch[], VectorizeSearchError>;
  readonly upsert: (
    vectors: readonly VectorizeVectorInput[],
  ) => Effect.Effect<void, VectorizeSearchError>;
  readonly deleteByIds: (ids: readonly string[]) => Effect.Effect<void, VectorizeSearchError>;
}

export const makeVectorizeStore = (index: VectorizeIndex): VectorizeStore => ({
  query: ({ vector, namespace, topK }) =>
    Effect.tryPromise({
      try: () =>
        index.query([...vector], {
          topK: Math.min(Math.max(1, topK), MAX_TOP_K),
          namespace,
          returnMetadata: "all",
        }),
      catch: (cause) => new VectorizeSearchError({ message: "Vectorize query failed.", cause }),
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
                new VectorizeSearchError({ message: "Vectorize upsert failed.", cause }),
            }),
          { concurrency: 1, discard: true },
        ),
  deleteByIds: (ids) =>
    ids.length === 0
      ? Effect.void
      : Effect.tryPromise({
          try: () => index.deleteByIds([...ids]),
          catch: (cause) =>
            new VectorizeSearchError({ message: "Vectorize delete failed.", cause }),
        }).pipe(Effect.asVoid),
});
