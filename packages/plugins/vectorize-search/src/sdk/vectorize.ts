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

/** Vectorize caps `topK` at 100 (with metadata). Clamp so a large
 *  offset+limit never trips the binding. */
const MAX_TOP_K = 100;

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
      : Effect.tryPromise({
          try: () => index.upsert([...vectors]),
          catch: (cause) =>
            new VectorizeSearchError({ message: "Vectorize upsert failed.", cause }),
        }).pipe(Effect.asVoid),
  deleteByIds: (ids) =>
    ids.length === 0
      ? Effect.void
      : Effect.tryPromise({
          try: () => index.deleteByIds([...ids]),
          catch: (cause) =>
            new VectorizeSearchError({ message: "Vectorize delete failed.", cause }),
        }).pipe(Effect.asVoid),
});
