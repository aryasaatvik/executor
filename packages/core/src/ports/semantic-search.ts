import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

// TODO: Migrate to ServiceMap.Service when moving to Effect v4

export interface SemanticSearchShape {
  readonly index: (input: {
    id: string;
    text: string;
    metadata?: Record<string, string>;
  }) => Effect.Effect<void, Error>;

  readonly search: (input: {
    query: string;
    limit?: number;
    filter?: Record<string, string>;
  }) => Effect.Effect<ReadonlyArray<{ id: string; score: number }>, Error>;

  readonly remove: (input: {
    id: string;
  }) => Effect.Effect<void, Error>;

  readonly isAvailable: () => Effect.Effect<boolean, Error>;
}

export class SemanticSearch extends Context.Tag(
  "@executor/core/SemanticSearch",
)<SemanticSearch, SemanticSearchShape>() {}
