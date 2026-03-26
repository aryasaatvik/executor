import {
  decodeProviderGrantRefAuthArtifactConfig,
  type AuthArtifact,
  type ProviderAuthGrant,
  type WorkspaceId,
} from "../../model";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { createDefaultSecretMaterialDeleter } from "../engine/secret-material-store";
import type { EngineStoreShape } from "../engine/store";

const providerGrantRefFromArtifact = (
  artifact: Pick<AuthArtifact, "artifactKind" | "configJson">,
) => decodeProviderGrantRefAuthArtifactConfig(artifact);

export const providerGrantIdFromArtifact = (
  artifact: Pick<AuthArtifact, "artifactKind" | "configJson">,
): ProviderAuthGrant["id"] | null =>
  providerGrantRefFromArtifact(artifact)?.grantId ?? null;

export const listProviderGrantRefArtifacts = (rows: EngineStoreShape, input: {
  workspaceId: WorkspaceId;
  grantId?: ProviderAuthGrant["id"] | null;
}): Effect.Effect<readonly AuthArtifact[], Error, never> =>
  Effect.map(
    rows.authArtifacts.listByWorkspaceId(input.workspaceId),
    (artifacts) =>
      artifacts.filter((artifact) => {
        const grantId = providerGrantIdFromArtifact(artifact);
        return grantId !== null && (input.grantId == null || grantId === input.grantId);
      }),
  );

export const clearProviderGrantOrphanedAt = (rows: EngineStoreShape, input: {
  grantId: ProviderAuthGrant["id"];
}): Effect.Effect<boolean, Error, never> =>
  Effect.gen(function* () {
    const grantOption = yield* rows.providerAuthGrants.getById(input.grantId);
    if (Option.isNone(grantOption) || grantOption.value.orphanedAt === null) {
      return false;
    }

    yield* rows.providerAuthGrants.upsert({
      ...grantOption.value,
      orphanedAt: null,
      updatedAt: Date.now(),
    });
    return true;
  });

export const markProviderGrantOrphanedIfUnused = (rows: EngineStoreShape, input: {
  workspaceId: WorkspaceId;
  grantId: ProviderAuthGrant["id"];
}): Effect.Effect<boolean, Error, never> =>
  Effect.gen(function* () {
    const references = yield* listProviderGrantRefArtifacts(rows, input);
    if (references.length > 0) {
      return false;
    }

    const grantOption = yield* rows.providerAuthGrants.getById(input.grantId);
    if (Option.isNone(grantOption) || grantOption.value.workspaceId !== input.workspaceId) {
      return false;
    }

    const grant = grantOption.value;
    if (grant.orphanedAt !== null) {
      return false;
    }

    yield* rows.providerAuthGrants.upsert({
      ...grant,
      orphanedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return true;
  });

export const removeProviderAuthGrantSecret = (rows: EngineStoreShape, input: {
  grant: ProviderAuthGrant;
}): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    const deleteSecretMaterial = createDefaultSecretMaterialDeleter({
      rows,
    });
    yield* deleteSecretMaterial(input.grant.refreshToken).pipe(
      Effect.either,
      Effect.ignore,
    );
  });
