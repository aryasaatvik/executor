import * as Effect from "effect/Effect";
import type { SourceStoreShape } from "@executor/core/ports";

export const createSqliteSourceStore = (): SourceStoreShape => ({
  list: (_input) => Effect.fail(new Error("TODO: implement sqlite source store list")),
  getById: (_input) => Effect.fail(new Error("TODO: implement sqlite source store getById")),
  create: (_input) => Effect.fail(new Error("TODO: implement sqlite source store create")),
  update: (_input) => Effect.fail(new Error("TODO: implement sqlite source store update")),
  remove: (_input) => Effect.fail(new Error("TODO: implement sqlite source store remove")),
});
