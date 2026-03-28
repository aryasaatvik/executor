import type {
  AccountId,
  Source,
} from "../../model";
import type { McpToolManifest } from "@executor/source-mcp";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RuntimeLocalWorkspace } from "../engine/runtime-context";
import { WorkspaceDatabase } from "../engine/workspace-database";
import {
  SourceAuthMaterial,
} from "../auth/source-auth-material";
import { SecretMaterialStore } from "../engine/secret-material-store";
import {
  type SyncSourceToSqlite,
  persistMcpCatalogSnapshotProgram,
  syncSourceCatalogProgram,
} from "../engine/programs";

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

export const RuntimeSourceCatalogSyncLive = (dependencies: {
  syncSourceToSqlite: SyncSourceToSqlite;
}) => Layer.effect(
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
      sync: (input) =>
        provideCatalogSyncDependencies(
          syncSourceCatalogProgram(input, dependencies),
        ) as Effect.Effect<void, Error, never>,
      persistMcpCatalogSnapshotFromManifest: (input) =>
        provideCatalogSyncDependencies(
          persistMcpCatalogSnapshotProgram(input, dependencies),
        ) as Effect.Effect<void, Error, never>,
    });
  }),
);
