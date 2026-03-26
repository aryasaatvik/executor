import * as Effect from "effect/Effect";
import type { ExecutionStoreShape } from "@executor/control-plane/ports";

export const createSqliteExecutionStore = (): ExecutionStoreShape => ({
  create: (_input) => Effect.fail(new Error("TODO: implement sqlite execution store create")),
  getById: (_input) => Effect.fail(new Error("TODO: implement sqlite execution store getById")),
  list: (_input) => Effect.fail(new Error("TODO: implement sqlite execution store list")),
  update: (_input) => Effect.fail(new Error("TODO: implement sqlite execution store update")),
  createInteraction: (_input) => Effect.fail(new Error("TODO: implement sqlite execution store createInteraction")),
  resolveInteraction: (_input) => Effect.fail(new Error("TODO: implement sqlite execution store resolveInteraction")),
  getPendingInteraction: (_input) => Effect.fail(new Error("TODO: implement sqlite execution store getPendingInteraction")),
  createStep: (_input) => Effect.fail(new Error("TODO: implement sqlite execution store createStep")),
  updateStep: (_input) => Effect.fail(new Error("TODO: implement sqlite execution store updateStep")),
  listSteps: (_input) => Effect.fail(new Error("TODO: implement sqlite execution store listSteps")),
});
