import type {
  AccountId,
  CredentialSlot,
  Source,
  SourceAuth,
} from "../../model";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { EngineStore, type EngineStoreShape } from "../engine/store";
import {
  authArtifactFromSourceAuth,
  resolveAuthArtifactMaterial,
  type ResolvedSourceAuthMaterial,
} from "./auth-artifacts";
import { resolveAuthArtifactMaterialWithLeases } from "./auth-leases";
import {
  type ResolveSecretMaterial,
  type SecretMaterialResolveContext,
  SecretMaterialStore,
} from "../engine/secret-material-store";
import { runtimeEffectError } from "../engine/errors";

const authForSlot = (input: {
  source: Source;
  slot: CredentialSlot;
}): SourceAuth => {
  if (input.slot === "runtime") {
    return input.source.auth;
  }

  if (input.source.importAuthPolicy === "reuse_runtime") {
    return input.source.auth;
  }

  if (input.source.importAuthPolicy === "none") {
    return { kind: "none" };
  }

  return input.source.importAuth;
};

export type RuntimeSourceAuthMaterialShape = {
  resolve: (input: {
    source: Source;
    slot?: CredentialSlot;
    actorAccountId?: AccountId | null;
    context?: SecretMaterialResolveContext;
  }) => Effect.Effect<ResolvedSourceAuthMaterial, Error, never>;
};

export class SourceAuthMaterial extends Context.Tag(
  "#runtime/SourceAuthMaterial",
)<SourceAuthMaterial, RuntimeSourceAuthMaterialShape>() {}

export const resolveSourceAuthMaterialWithDeps = (input: {
  source: Source;
  slot?: CredentialSlot;
  actorAccountId?: AccountId | null;
  rows?: EngineStoreShape;
  resolveSecretMaterial: ResolveSecretMaterial;
  context?: SecretMaterialResolveContext;
}): Effect.Effect<ResolvedSourceAuthMaterial, Error, never> =>
  Effect.gen(function* () {
    const slot = input.slot ?? "runtime";

    if (input.rows !== undefined) {
      const candidateSlots =
        slot === "import" && input.source.importAuthPolicy === "reuse_runtime"
          ? ["import", "runtime"] satisfies ReadonlyArray<CredentialSlot>
          : [slot] satisfies ReadonlyArray<CredentialSlot>;

      for (const candidateSlot of candidateSlots) {
        const artifactOption = yield* input.rows.authArtifacts.getByWorkspaceSourceAndActor({
          workspaceId: input.source.workspaceId,
          sourceId: input.source.id,
          actorAccountId: input.actorAccountId ?? null,
          slot: candidateSlot,
        });

        if (Option.isSome(artifactOption)) {
          return yield* resolveAuthArtifactMaterialWithLeases({
            rows: input.rows,
            artifact: artifactOption.value,
            resolveSecretMaterial: input.resolveSecretMaterial,
            context: input.context,
          });
        }
      }
    }

    const artifact = authArtifactFromSourceAuth({
      source: input.source,
      auth: authForSlot({
        source: input.source,
        slot,
      }),
      slot,
      actorAccountId: input.actorAccountId ?? null,
    });

    if (input.rows !== undefined) {
      return yield* resolveAuthArtifactMaterialWithLeases({
        rows: input.rows,
        artifact,
        resolveSecretMaterial: input.resolveSecretMaterial,
        context: input.context,
      });
    }

    if (
      artifact?.artifactKind === "oauth2_authorized_user"
      || artifact?.artifactKind === "provider_grant_ref"
      || artifact?.artifactKind === "mcp_oauth"
    ) {
      return yield* runtimeEffectError("auth/source-auth-material", "Dynamic auth artifacts require persistence-backed lease resolution");
    }

    return yield* resolveAuthArtifactMaterial({
      artifact,
      resolveSecretMaterial: input.resolveSecretMaterial,
      context: input.context,
    });
  });

export const resolveSourceAuthMaterial = (input: {
  source: Source;
  slot?: CredentialSlot;
  actorAccountId?: AccountId | null;
  context?: SecretMaterialResolveContext;
}): Effect.Effect<ResolvedSourceAuthMaterial, Error, SourceAuthMaterial> =>
  Effect.flatMap(SourceAuthMaterial, (service) => service.resolve(input));

export const RuntimeSourceAuthMaterialLive = Layer.effect(
  SourceAuthMaterial,
  Effect.gen(function* () {
    const rows = yield* EngineStore;
    const secretMaterialStore = yield* SecretMaterialStore;

    return SourceAuthMaterial.of({
      resolve: (input) =>
        resolveSourceAuthMaterialWithDeps({
          ...input,
          rows,
          resolveSecretMaterial: secretMaterialStore.resolve,
        }),
    });
  }),
);

export type { ResolvedSourceAuthMaterial } from "./auth-artifacts";
