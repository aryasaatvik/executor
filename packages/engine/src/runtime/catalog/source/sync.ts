import type {
  AccountId,
  Source,
} from "#schema";
import type { McpToolManifest } from "@executor/source-mcp";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  RuntimeLocalWorkspace,
} from "../../local/runtime-context";
import { WorkspaceDatabase } from "../../local/workspace-database";
import {
  SourceAuthMaterial,
} from "../../auth/source-auth-material";
import { SecretMaterialStore } from "../../local/secret-material-providers";
import {
  persistMcpCatalogSnapshotProgram,
  syncSourceCatalogProgram,
} from "../../programs/catalog/source-sync";

export type RuntimeSourceCatalogSyncShape = {
  sync: (input: {
    source: Source;
    actorAccountId?: AccountId | null;
  }) => Effect.Effect<void, Error, never>;
  persistMcpCatalogSnapshotFromManifest: (input: {
    source: Source;
    manifest: McpToolManifest;
  }) => Effect.Effect<void, Error, never>;
};

export class SourceCatalogSync extends Context.Tag(
  "#runtime/SourceCatalogSync",
)<SourceCatalogSync, RuntimeSourceCatalogSyncShape>() {}

export const RuntimeSourceCatalogSyncLive = Layer.effect(
  SourceCatalogSync,
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* RuntimeLocalWorkspace;
    const sourceAuthMaterial = yield* SourceAuthMaterial;
    const secretMaterialStore = yield* SecretMaterialStore;
    const workspaceDatabase = yield* WorkspaceDatabase;

    const provideCatalogSyncDependencies = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) =>
      effect.pipe(
        Effect.provideService(RuntimeLocalWorkspace, runtimeLocalWorkspace),
        Effect.provideService(SourceAuthMaterial, sourceAuthMaterial),
        Effect.provideService(
          SecretMaterialStore,
          secretMaterialStore,
        ),
        Effect.provideService(WorkspaceDatabase, workspaceDatabase),
      );

    return SourceCatalogSync.of({
      sync: (input) => provideCatalogSyncDependencies(syncSourceCatalogProgram(input)),
      persistMcpCatalogSnapshotFromManifest: (input) =>
        provideCatalogSyncDependencies(persistMcpCatalogSnapshotProgram(input)),
    });
  }),
);
