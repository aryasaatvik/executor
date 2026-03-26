import * as Effect from "effect/Effect";
import type { ExecutionStoreShape } from "@executor/control-plane/ports";

// TODO: Implement with D1 + Drizzle in Phase 6

export const createD1ExecutionStore = (): ExecutionStoreShape => ({
  create: (_input) => Effect.fail(new Error("TODO: implement D1 execution store create")),
  getById: (_input) => Effect.fail(new Error("TODO: implement D1 execution store getById")),
  list: (_input) => Effect.fail(new Error("TODO: implement D1 execution store list")),
  update: (_input) => Effect.fail(new Error("TODO: implement D1 execution store update")),
  createInteraction: (_input) => Effect.fail(new Error("TODO: implement D1 execution store createInteraction")),
  resolveInteraction: (_input) => Effect.fail(new Error("TODO: implement D1 execution store resolveInteraction")),
  getPendingInteraction: (_input) => Effect.fail(new Error("TODO: implement D1 execution store getPendingInteraction")),
  createStep: (_input) => Effect.fail(new Error("TODO: implement D1 execution store createStep")),
  updateStep: (_input) => Effect.fail(new Error("TODO: implement D1 execution store updateStep")),
  listSteps: (_input) => Effect.fail(new Error("TODO: implement D1 execution store listSteps")),
});
