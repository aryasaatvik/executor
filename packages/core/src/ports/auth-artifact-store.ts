import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  AccountId,
  AuthArtifact,
  AuthArtifactSlot,
  AuthLease,
  SourceId,
  WorkspaceId,
} from "../model/index";

// TODO: Migrate to ServiceMap.Service when moving to Effect v4

export interface AuthArtifactStoreShape {
  readonly getArtifact: (input: {
    workspaceId: WorkspaceId;
    sourceId: SourceId;
    slot: AuthArtifactSlot;
    accountId?: AccountId | null;
  }) => Effect.Effect<AuthArtifact | null, Error>;

  readonly upsertArtifact: (input: {
    artifact: Omit<AuthArtifact, "id" | "createdAt" | "updatedAt">;
  }) => Effect.Effect<AuthArtifact, Error>;

  readonly removeArtifact: (input: {
    artifactId: string;
  }) => Effect.Effect<boolean, Error>;

  readonly acquireLease: (input: {
    artifact: AuthArtifact;
  }) => Effect.Effect<AuthLease, Error>;

  readonly releaseLease: (input: {
    leaseId: string;
  }) => Effect.Effect<boolean, Error>;
}

export class AuthArtifactStore extends Context.Tag(
  "@executor/core/AuthArtifactStore",
)<AuthArtifactStore, AuthArtifactStoreShape>() {}
