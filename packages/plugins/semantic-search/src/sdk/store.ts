import { Effect } from "effect";

import { SemanticSearchError } from "./errors";

export interface VectorMatches {
  readonly matches: readonly VectorMatch[];
  readonly count?: number;
}

export interface VectorMatch {
  readonly id: string;
  readonly score: number;
  readonly namespace?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface VectorInput {
  readonly id: string;
  readonly values: readonly number[];
  readonly namespace?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Effect-wrapped, plugin-facing view over a vector store backend. */
export interface VectorStore {
  /** Maximum number of results a single `query` can return for this backend. */
  readonly maxTopK: number;
  readonly query: (input: {
    readonly vector: readonly number[];
    readonly namespace: string;
    readonly topK: number;
  }) => Effect.Effect<readonly VectorMatch[], SemanticSearchError>;
  readonly upsert: (vectors: readonly VectorInput[]) => Effect.Effect<void, SemanticSearchError>;
  readonly deleteByIds: (ids: readonly string[]) => Effect.Effect<void, SemanticSearchError>;
}
