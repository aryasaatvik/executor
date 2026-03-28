import * as Effect from "effect/Effect";
import type { SemanticSearchShape } from "@executor/core/ports";

export const createSqliteVecSearch = (): SemanticSearchShape => ({
  index: (_input) => Effect.fail(new Error("TODO: implement sqlite-vec search index")),
  search: (_input) => Effect.fail(new Error("TODO: implement sqlite-vec search query")),
  remove: (_input) => Effect.fail(new Error("TODO: implement sqlite-vec search remove")),
  isAvailable: () => Effect.succeed(false),
});
