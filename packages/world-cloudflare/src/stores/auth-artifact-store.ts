import * as Effect from "effect/Effect";
import type { AuthArtifactStoreShape } from "@executor/core/ports";

// TODO: Implement with D1 + Drizzle in Phase 6

export const createD1AuthArtifactStore = (): AuthArtifactStoreShape => ({
  getArtifact: (_input) => Effect.fail(new Error("TODO: implement D1 auth artifact store getArtifact")),
  upsertArtifact: (_input) => Effect.fail(new Error("TODO: implement D1 auth artifact store upsertArtifact")),
  removeArtifact: (_input) => Effect.fail(new Error("TODO: implement D1 auth artifact store removeArtifact")),
  acquireLease: (_input) => Effect.fail(new Error("TODO: implement D1 auth artifact store acquireLease")),
  releaseLease: (_input) => Effect.fail(new Error("TODO: implement D1 auth artifact store releaseLease")),
});
