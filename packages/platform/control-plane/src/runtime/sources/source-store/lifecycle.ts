import { EXECUTOR_DB_FILENAME } from "../../../db/client.js"
import type { AccountId, Source, WorkspaceId } from "#schema";
import * as Effect from "effect/Effect";
import { join } from "node:path";

import { removeAuthLeaseAndSecrets } from "../../auth/auth-leases";
import {
  clearProviderGrantOrphanedAt,
  markProviderGrantOrphanedIfUnused,
} from "../../auth/provider-grant-lifecycle";
import {
  stableSourceCatalogId,
  stableSourceCatalogRevisionId,
  splitSourceForStorage,
} from "../source-definitions";
import {
  cleanupAuthArtifactSecretRefs,
  providerGrantIdsFromArtifacts,
  removeAuthArtifactsForSource,
  selectExactAuthArtifact,
} from "./auth";
import {
  configSourceFromLocalSource,
  cloneJson,
  deriveLocalSourceId,
} from "./config";
import {
  type RuntimeSourceStoreDeps,
  resolveRuntimeLocalWorkspaceFromDeps,
} from "./deps";
import {
  loadSourceByIdWithDeps,
  shouldRefreshWorkspaceDeclarationsAfterPersist,
  syncWorkspaceSourceTypeDeclarationsWithDeps,
} from "./records";
import { upsertSourceStatusToDb, removeSourceFromDb, loadSourceStatusFromDb } from "../../../db/indexer";
import { makeWorkspaceCatalogDbLayer } from "../../../db/setup";


export const removeSourceByIdWithDeps = (
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

    // Remove source from SQLite (CASCADE deletes handle catalog_tool, etc.)
    const dbPath = join(
      localWorkspace.context.stateDirectory,
      EXECUTOR_DB_FILENAME,
    );
    const dbLayer = makeWorkspaceCatalogDbLayer(dbPath);
    yield* removeSourceFromDb(input.sourceId).pipe(
      Effect.provide(dbLayer),
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

export const persistSourceWithDeps = (
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

    // Check if source exists in DB for ID derivation
    const dbPath = join(
      localWorkspace.context.stateDirectory,
      EXECUTOR_DB_FILENAME,
    );
    const dbLayer = makeWorkspaceCatalogDbLayer(dbPath);
    const existingDbStatus = yield* loadSourceStatusFromDb(source.id).pipe(
      Effect.provide(dbLayer),
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

    // Write source status to SQLite
    yield* upsertSourceStatusToDb({
      sourceId: nextSource.id,
      workspaceId: nextSource.workspaceId,
      name: nextSource.name,
      kind: nextSource.kind,
      endpoint: nextSource.endpoint,
      status: nextSource.status,
      enabled: nextSource.enabled,
      namespace: nextSource.namespace,
      lastError: nextSource.lastError,
      sourceHash: nextSource.sourceHash,
      createdAt: existingDbStatus?.createdAt ?? nextSource.createdAt,
      updatedAt: nextSource.updatedAt,
    }).pipe(
      Effect.provide(dbLayer),
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
