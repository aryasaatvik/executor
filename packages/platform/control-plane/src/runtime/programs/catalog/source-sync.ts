import type {
  AccountId,
  Source,
  SourceStatus,
} from "#schema";
import type { McpToolManifest } from "@executor/source-mcp";
import { catalogSyncResultFromMcpManifest } from "@executor/source-mcp";
import type { SourceCatalogSyncResult } from "@executor/source-core";
import * as Effect from "effect/Effect";

import { RuntimeLocalWorkspace } from "../../local/runtime-context";
import { SourceAuthMaterial } from "../../auth/source-auth-material";
import { getSourceAdapterForSource } from "../../sources/source-adapters";
import { SecretMaterialStore } from "../../local/secret-material-providers";
import { WorkspaceDatabase } from "../../local/workspace-database";
import { refreshSourceTypeDeclarationInBackground } from "../../catalog/source/type-declarations";
import { runtimeEffectError } from "../../effect-errors";
import { syncSourceToSqlite } from "../../../db/indexer";
import { syncSourceLifecycle } from "../../../db/source-state";

const shouldIndexSource = (source: Source): boolean =>
  source.enabled
  && source.status === "connected"
  && getSourceAdapterForSource(source).catalogKind !== "internal";

const ensureRuntimeCatalogSyncWorkspace = (workspaceId: Source["workspaceId"]) =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* RuntimeLocalWorkspace;

    if (runtimeLocalWorkspace.installation.workspaceId !== workspaceId) {
      return yield* runtimeEffectError(
        "catalog/source/sync",
        `Runtime local workspace mismatch: expected ${workspaceId}, got ${runtimeLocalWorkspace.installation.workspaceId}`,
      );
    }

    return runtimeLocalWorkspace;
  });

const persistSourceCatalogSnapshotToSqlite = (input: {
  source: Source;
  syncResult: SourceCatalogSyncResult;
}) =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* ensureRuntimeCatalogSyncWorkspace(
      input.source.workspaceId,
    );
    const workspaceDatabase = yield* WorkspaceDatabase;

    const result = yield* syncSourceToSqlite({
      source: input.source,
      syncResult: input.syncResult,
    }).pipe(
      Effect.provide(workspaceDatabase.writeLayer()),
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );

    yield* Effect.sync(() => {
      refreshSourceTypeDeclarationInBackground({
        context: runtimeLocalWorkspace.context,
        source: input.source,
        snapshot: result.snapshot,
      });
    });

    return result.snapshot;
  });

const sourceCatalogSyncResultFromMcpManifest = (input: {
  source: Source;
  manifest: McpToolManifest;
}): SourceCatalogSyncResult =>
  catalogSyncResultFromMcpManifest({
    source: input.source,
    endpoint: input.source.endpoint,
    manifest: input.manifest,
  });

export const syncSourceCatalogProgram = (input: {
  source: Source;
  actorAccountId?: AccountId | null;
}) =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* ensureRuntimeCatalogSyncWorkspace(
      input.source.workspaceId,
    );
    const workspaceDatabase = yield* WorkspaceDatabase;

    if (!shouldIndexSource(input.source)) {
      yield* syncSourceLifecycle({
        sourceId: input.source.id,
        source: {
          sourceId: input.source.id,
          workspaceId: input.source.workspaceId,
          name: input.source.name,
          kind: input.source.kind,
          endpoint: input.source.endpoint,
          status: (input.source.enabled ? input.source.status : "draft") as SourceStatus,
          enabled: input.source.enabled,
          namespace: input.source.namespace,
          createdAt: input.source.createdAt,
          updatedAt: Date.now(),
        },
      }).pipe(
        Effect.provide(workspaceDatabase.writeLayer()),
        Effect.catchAll(() => Effect.void),
      );

      yield* Effect.sync(() => {
        refreshSourceTypeDeclarationInBackground({
          context: runtimeLocalWorkspace.context,
          source: input.source,
          snapshot: null,
        });
      });
      return;
    }

    const adapter = getSourceAdapterForSource(input.source);
    const secretMaterialStore = yield* SecretMaterialStore;
    const sourceAuthMaterial = yield* SourceAuthMaterial;

    const syncResult = yield* adapter.syncCatalog({
      source: input.source,
      resolveSecretMaterial: secretMaterialStore.resolve,
      resolveAuthMaterialForSlot: (slot) =>
        sourceAuthMaterial.resolve({
          source: input.source,
          slot,
          actorAccountId: input.actorAccountId,
        }),
    });

    yield* persistSourceCatalogSnapshotToSqlite({
      source: input.source,
      syncResult,
    });
  }).pipe(
    Effect.withSpan("source.catalog.sync", {
      attributes: {
        "executor.source.id": input.source.id,
        "executor.source.kind": input.source.kind,
        "executor.source.namespace": input.source.namespace,
        "executor.source.endpoint": input.source.endpoint,
      },
    }),
  );

export const persistMcpCatalogSnapshotProgram = (input: {
  source: Source;
  manifest: McpToolManifest;
}) =>
  Effect.gen(function* () {
    const syncResult = sourceCatalogSyncResultFromMcpManifest(input);
    yield* persistSourceCatalogSnapshotToSqlite({
      source: input.source,
      syncResult,
    });
  });
