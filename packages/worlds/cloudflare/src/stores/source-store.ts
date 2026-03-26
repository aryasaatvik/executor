import * as Effect from "effect/Effect";
import type { SourceStoreShape } from "@executor/control-plane/ports";

// TODO: Implement with D1 + Drizzle in Phase 6

export const createD1SourceStore = (): SourceStoreShape => ({
  list: (_input) => Effect.fail(new Error("TODO: implement D1 source store list")),
  getById: (_input) => Effect.fail(new Error("TODO: implement D1 source store getById")),
  create: (_input) => Effect.fail(new Error("TODO: implement D1 source store create")),
  update: (_input) => Effect.fail(new Error("TODO: implement D1 source store update")),
  remove: (_input) => Effect.fail(new Error("TODO: implement D1 source store remove")),
});
