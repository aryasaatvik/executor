import * as Effect from "effect/Effect";
import type { AuthArtifactStoreShape } from "@executor/core/ports";

export const createSqliteAuthStore = (): AuthArtifactStoreShape => ({
  getArtifact: (_input) => Effect.fail(new Error("TODO: implement sqlite auth artifact store getArtifact")),
  upsertArtifact: (_input) => Effect.fail(new Error("TODO: implement sqlite auth artifact store upsertArtifact")),
  removeArtifact: (_input) => Effect.fail(new Error("TODO: implement sqlite auth artifact store removeArtifact")),
  acquireLease: (_input) => Effect.fail(new Error("TODO: implement sqlite auth artifact store acquireLease")),
  releaseLease: (_input) => Effect.fail(new Error("TODO: implement sqlite auth artifact store releaseLease")),
});
