import { Context, Effect } from "effect";

export interface VectorSearchShape {
  /** Upsert embedding vectors for tools/documents */
  readonly upsert: (
    vectors: ReadonlyArray<{
      readonly id: string;
      readonly embedding: ReadonlyArray<number>;
      readonly metadata?: Record<string, string>;
    }>
  ) => Effect.Effect<void>;

  /** Query for similar vectors, returning ranked results */
  readonly query: (
    embedding: ReadonlyArray<number>,
    options: {
      readonly topK: number;
      readonly filter?: Record<string, string>;
    }
  ) => Effect.Effect<ReadonlyArray<VectorSearchResult>>;

  /** Delete vectors by IDs */
  readonly delete: (ids: ReadonlyArray<string>) => Effect.Effect<void>;

  /** Number of dimensions the vectors use */
  readonly dimensions: number;
}

export interface VectorSearchResult {
  readonly id: string;
  readonly score: number;
  readonly metadata?: Record<string, string>;
}

export class VectorSearch extends Context.Tag("@executor/core/VectorSearch")<
  VectorSearch,
  VectorSearchShape
>() {}
