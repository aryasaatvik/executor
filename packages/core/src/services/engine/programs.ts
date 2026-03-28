// Source & catalog programs — copied from @executor/engine
// Adapted to use control-plane local imports.
import type {
  AccountId,
  Source,
  SourceStatus,
  WorkspaceId,
} from "../../model/index";
import type { McpToolManifest } from "@executor/source-mcp";
import { catalogSyncResultFromMcpManifest } from "@executor/source-mcp";
import type { SourceCatalogSyncResult } from "@executor/source-core";
import * as Effect from "effect/Effect";
import type { CatalogSnapshotV1 } from "@executor/execution-ir/model";

import { removeAuthLeaseAndSecrets } from "../auth/auth-leases";
import {
  clearProviderGrantOrphanedAt,
  markProviderGrantOrphanedIfUnused,
} from "../auth/provider-grant-lifecycle";
import {
  stableSourceCatalogId,
  stableSourceCatalogRevisionId,
  splitSourceForStorage,
} from "../sources/source-definitions";
import {
  cleanupAuthArtifactSecretRefs,
  providerGrantIdsFromArtifacts,
  removeAuthArtifactsForSource,
  selectExactAuthArtifact,
} from "../sources/source-store-auth";
import {
  configSourceFromLocalSource,
  cloneJson,
  deriveLocalSourceId,
} from "../sources/source-store-config";
import {
  type RuntimeSourceStoreDeps,
  resolveRuntimeLocalWorkspaceFromDeps,
} from "../sources/source-store-deps";
import {
  loadSourceByIdWithDeps,
  shouldRefreshWorkspaceDeclarationsAfterPersist,
  syncWorkspaceSourceTypeDeclarationsWithDeps,
} from "../sources/source-store-records";
import { loadSourceStatus, removeSource, upsertSourceStatus, syncSourceLifecycle } from "./db-queries";
import { makeWorkspaceDatabase } from "./workspace-database";
import { RuntimeLocalWorkspace } from "./runtime-context";
import { SourceAuthMaterial } from "../auth/source-auth-material";
import { getSourceAdapterForSource } from "./source-adapters";
import { SecretMaterialStore } from "./secret-material-store";
import { WorkspaceDatabase } from "./workspace-database";
import { refreshSourceTypeDeclarationInBackground } from "../catalog/type-declarations";
import { runtimeEffectError } from "./errors";

export type SyncSourceToSqlite = (input: {
  source: Source;
  syncResult: SourceCatalogSyncResult;
}) => Effect.Effect<{
  snapshot: CatalogSnapshotV1;
}, Error, unknown>;

type CatalogPersistenceDependencies = {
  syncSourceToSqlite: SyncSourceToSqlite;
};

// ---------------------------------------------------------------------------
// persistSourceProgram
// ---------------------------------------------------------------------------

export const persistSourceProgram = (
  deps: RuntimeSourceStoreDeps,
  source: Source,
  options: {
    actorAccountId?: AccountId | null;
  } = {},
): Effect.Effect<Source, Error, never> =>
  Effect.gen(function* () {
    const localWorkspace = yield* resolveRuntimeLocalWorkspaceFromDeps(
      deps,
      source.workspaceId,
    );
    const workspaceDatabase = makeWorkspaceDatabase(localWorkspace);

    const existingDbStatus = yield* loadSourceStatus(source.id).pipe(
      Effect.provide(workspaceDatabase.queryLayer()),
      Effect.catchAll(() => Effect.succeed(null)),
    );

    const nextSource = {
      ...source,
      id:
        localWorkspace.loadedConfig.config?.sources?.[source.id] ||
        existingDbStatus !== null
          ? source.id
          : deriveLocalSourceId(
              source,
              new Set(Object.keys(localWorkspace.loadedConfig.config?.sources ?? {})),
            ),
    } satisfies Source;
    const existingAuthArtifacts =
      yield* deps.rows.authArtifacts.listByWorkspaceAndSourceId({
        workspaceId: nextSource.workspaceId,
        sourceId: nextSource.id,
      });
    const existingRuntimeAuthArtifact = selectExactAuthArtifact({
      authArtifacts: existingAuthArtifacts,
      actorAccountId: options.actorAccountId,
      slot: "runtime",
    });
    const existingImportAuthArtifact = selectExactAuthArtifact({
      authArtifacts: existingAuthArtifacts,
      actorAccountId: options.actorAccountId,
      slot: "import",
    });
    const projectConfig = cloneJson(localWorkspace.loadedConfig.projectConfig ?? {});
    const sources = {
      ...projectConfig.sources,
    };
    const existingConfigSource = sources[nextSource.id];
    sources[nextSource.id] = configSourceFromLocalSource({
      source: nextSource,
      existingConfigAuth: existingConfigSource?.connection.auth,
      config: localWorkspace.loadedConfig.config,
    });
    yield* localWorkspace.workspaceConfigStore.writeProject({
      context: localWorkspace.context,
      config: {
        ...projectConfig,
        sources,
      },
    });

    const { runtimeAuthArtifact, importAuthArtifact } = splitSourceForStorage({
      source: nextSource,
      catalogId: stableSourceCatalogId(nextSource),
      catalogRevisionId: stableSourceCatalogRevisionId(nextSource),
      actorAccountId: options.actorAccountId,
      existingRuntimeAuthArtifactId: existingRuntimeAuthArtifact?.id ?? null,
      existingImportAuthArtifactId: existingImportAuthArtifact?.id ?? null,
    });

    if (runtimeAuthArtifact === null) {
      if (existingRuntimeAuthArtifact !== null) {
        yield* removeAuthLeaseAndSecrets(deps.rows, {
          authArtifactId: existingRuntimeAuthArtifact.id,
        });
      }
      yield* deps.rows.authArtifacts.removeByWorkspaceSourceAndActor({
        workspaceId: nextSource.workspaceId,
        sourceId: nextSource.id,
        actorAccountId: options.actorAccountId ?? null,
        slot: "runtime",
      });
    } else {
      yield* deps.rows.authArtifacts.upsert(runtimeAuthArtifact);
      if (
        existingRuntimeAuthArtifact !== null &&
        existingRuntimeAuthArtifact.id !== runtimeAuthArtifact.id
      ) {
        yield* removeAuthLeaseAndSecrets(deps.rows, {
          authArtifactId: existingRuntimeAuthArtifact.id,
        });
      }
    }

    yield* cleanupAuthArtifactSecretRefs(deps.rows, {
      previous: existingRuntimeAuthArtifact ?? null,
      next: runtimeAuthArtifact,
    });

    if (importAuthArtifact === null) {
      if (existingImportAuthArtifact !== null) {
        yield* removeAuthLeaseAndSecrets(deps.rows, {
          authArtifactId: existingImportAuthArtifact.id,
        });
      }
      yield* deps.rows.authArtifacts.removeByWorkspaceSourceAndActor({
        workspaceId: nextSource.workspaceId,
        sourceId: nextSource.id,
        actorAccountId: options.actorAccountId ?? null,
        slot: "import",
      });
    } else {
      yield* deps.rows.authArtifacts.upsert(importAuthArtifact);
      if (
        existingImportAuthArtifact !== null &&
        existingImportAuthArtifact.id !== importAuthArtifact.id
      ) {
        yield* removeAuthLeaseAndSecrets(deps.rows, {
          authArtifactId: existingImportAuthArtifact.id,
        });
      }
    }

    yield* cleanupAuthArtifactSecretRefs(deps.rows, {
      previous: existingImportAuthArtifact ?? null,
      next: importAuthArtifact,
    });

    const previousGrantIds = providerGrantIdsFromArtifacts([
      existingRuntimeAuthArtifact,
      existingImportAuthArtifact,
    ]);
    const nextGrantIds = providerGrantIdsFromArtifacts([
      runtimeAuthArtifact,
      importAuthArtifact,
    ]);

    yield* Effect.forEach(
      [...nextGrantIds],
      (grantId) =>
        clearProviderGrantOrphanedAt(deps.rows, {
          grantId,
        }),
      { discard: true },
    );
    yield* Effect.forEach(
      [...previousGrantIds].filter((grantId) => !nextGrantIds.has(grantId)),
      (grantId) =>
        markProviderGrantOrphanedIfUnused(deps.rows, {
          workspaceId: nextSource.workspaceId,
          grantId,
        }),
      { discard: true },
    );

    yield* upsertSourceStatus({
        sourceId: nextSource.id,
        workspaceId: nextSource.workspaceId,
        catalogId: stableSourceCatalogId(nextSource),
        status: nextSource.status,
        enabled: nextSource.enabled,
        lastError: nextSource.lastError,
        sourceHash: nextSource.sourceHash,
        createdAt: existingDbStatus?.createdAt ?? nextSource.createdAt,
        updatedAt: nextSource.updatedAt,
      }).pipe(
        Effect.provide(workspaceDatabase.writeLayer()),
        Effect.catchAll(() => Effect.void),
      );

    if (shouldRefreshWorkspaceDeclarationsAfterPersist(nextSource)) {
      yield* syncWorkspaceSourceTypeDeclarationsWithDeps(
        deps,
        nextSource.workspaceId,
        options,
      );
    }

    return yield* loadSourceByIdWithDeps(deps, {
      workspaceId: nextSource.workspaceId,
      sourceId: nextSource.id,
      actorAccountId: options.actorAccountId,
    });
  }).pipe(
    Effect.withSpan("source.store.persist", {
      attributes: {
        "executor.workspace.id": source.workspaceId,
        "executor.source.id": source.id,
        "executor.source.kind": source.kind,
        "executor.source.status": source.status,
      },
    }),
  );

// ---------------------------------------------------------------------------
// removeSourceByIdProgram
// ---------------------------------------------------------------------------

export const removeSourceByIdProgram = (
  deps: RuntimeSourceStoreDeps,
  input: {
    workspaceId: WorkspaceId;
    sourceId: Source["id"];
  },
): Effect.Effect<boolean, Error, never> =>
  Effect.gen(function* () {
    const localWorkspace = yield* resolveRuntimeLocalWorkspaceFromDeps(
      deps,
      input.workspaceId,
    );
    const workspaceDatabase = makeWorkspaceDatabase(localWorkspace);
    if (!localWorkspace.loadedConfig.config?.sources?.[input.sourceId]) {
      return false;
    }

    const projectConfig = cloneJson(localWorkspace.loadedConfig.projectConfig ?? {});
    const sources = {
      ...projectConfig.sources,
    };
    delete sources[input.sourceId];
    yield* localWorkspace.workspaceConfigStore.writeProject({
      context: localWorkspace.context,
      config: {
        ...projectConfig,
        sources,
      },
    });

    yield* removeSource(input.sourceId).pipe(
      Effect.provide(workspaceDatabase.writeLayer()),
      Effect.catchAll(() => Effect.void),
    );

    const existingAuthArtifacts =
      yield* deps.rows.authArtifacts.listByWorkspaceAndSourceId({
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
      });
    const removedGrantIds = providerGrantIdsFromArtifacts(existingAuthArtifacts);

    yield* deps.rows.sourceAuthSessions.removeByWorkspaceAndSourceId(
      input.workspaceId,
      input.sourceId,
    );
    yield* deps.rows.sourceOauthClients.removeByWorkspaceAndSourceId({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
    });
    yield* removeAuthArtifactsForSource(deps.rows, input);
    yield* Effect.forEach(
      [...removedGrantIds],
      (grantId) =>
        markProviderGrantOrphanedIfUnused(deps.rows, {
          workspaceId: input.workspaceId,
          grantId,
        }),
      { discard: true },
    );
    yield* syncWorkspaceSourceTypeDeclarationsWithDeps(deps, input.workspaceId);

    return true;
  });

// ---------------------------------------------------------------------------
// syncSourceCatalogProgram
// ---------------------------------------------------------------------------

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
}, dependencies: CatalogPersistenceDependencies) =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* ensureRuntimeCatalogSyncWorkspace(
      input.source.workspaceId,
    );
    const workspaceDatabase = yield* WorkspaceDatabase;

    const result = yield* dependencies.syncSourceToSqlite({
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
}, dependencies: CatalogPersistenceDependencies) =>
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
          catalogId: null,
          catalogRevisionId: null,
          status: (input.source.enabled ? input.source.status : "draft") as SourceStatus,
          enabled: input.source.enabled,
          sourceHash: input.source.sourceHash,
          lastError: input.source.lastError,
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
    }, dependencies);
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

// ---------------------------------------------------------------------------
// persistMcpCatalogSnapshotProgram
// ---------------------------------------------------------------------------

export const persistMcpCatalogSnapshotProgram = (input: {
  source: Source;
  manifest: McpToolManifest;
}, dependencies: CatalogPersistenceDependencies) =>
  Effect.gen(function* () {
    const syncResult = sourceCatalogSyncResultFromMcpManifest(input);
    yield* persistSourceCatalogSnapshotToSqlite({
      source: input.source,
      syncResult,
    }, dependencies);
  });
