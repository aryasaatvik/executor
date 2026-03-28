import * as Effect from "effect/Effect";
import type { SemanticSearchShape } from "@executor/core/ports";

// TODO: Implement with Vectorize in Phase 6

export const createVectorizeSearch = (): SemanticSearchShape => ({
  index: (_input) => Effect.fail(new Error("TODO: implement Vectorize search index")),
  search: (_input) => Effect.fail(new Error("TODO: implement Vectorize search query")),
  remove: (_input) => Effect.fail(new Error("TODO: implement Vectorize search remove")),
  isAvailable: () => Effect.succeed(false),
});
