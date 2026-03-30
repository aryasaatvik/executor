import type {
  ScopeId,
  Source,
  SourceStatus,
} from "#schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  RuntimeLocalScopeService,
  type RuntimeLocalScopeState,
} from "../../scope/runtime-context";
import {
  ScopeConfigStore,
  type ScopeConfigStoreShape,
  SourceArtifactStore,
  type SourceArtifactStoreShape,
  ScopeStateStore,
  type ScopeStateStoreShape,
} from "../../scope/storage";
import {
  type LocalScopeState,
} from "../../scope-state";
import {
  getSourceContributionForSource,
  ExecutorPluginRegistryService,
} from "../../sources/source-plugins";
import {
  snapshotFromSourceCatalogSyncResult,
} from "@executor/source-core";
import {
  SourceTypeDeclarationsRefresherService,
  type SourceTypeDeclarationsRefresherShape,
} from "./type-declarations";
import {
  runtimeEffectError,
} from "../../effect-errors";
import {
  ExecutorStateStore,
} from "../../executor-state-store";
import {
  LocalToolRuntimeLoaderService,
  type LocalToolRuntimeLoaderShape,
} from "../../local-tool-runtime";
import {
  SecretMaterialDeleterService,
  SecretMaterialResolverService,
  SecretMaterialStorerService,
  SecretMaterialUpdaterService,
  type DeleteSecretMaterial,
  type ResolveSecretMaterial,
  type StoreSecretMaterial,
  type UpdateSecretMaterial,
} from "../../scope/secret-material-providers";
import {
  RuntimeSearchManagerService,
} from "../../search/manager";
import {
  expandCatalogTools,
  loadSourceWithCatalog,
} from "./runtime";
import {
  searchDocumentFromLoadedTool,
} from "../../search/documents";
import {
  RuntimeSourceStoreService,
} from "../../sources/source-store";

const shouldIndexSource = (source: Source): boolean =>
  source.enabled
  && source.status === "connected";

type RuntimeSourceCatalogSyncDeps = {
  pluginRegistry: Effect.Effect.Success<typeof ExecutorPluginRegistryService>;
  runtimeLocalScope: RuntimeLocalScopeState;
  executorStateStore: Effect.Effect.Success<typeof ExecutorStateStore>;
  sourceStore: Effect.Effect.Success<typeof RuntimeSourceStoreService>;
  localToolRuntimeLoader: LocalToolRuntimeLoaderShape;
  scopeConfigStore: ScopeConfigStoreShape;
  scopeStateStore: ScopeStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
  sourceTypeDeclarationsRefresher: SourceTypeDeclarationsRefresherShape;
  secretMaterialServices: {
    resolve: ResolveSecretMaterial;
    store: StoreSecretMaterial;
    delete: DeleteSecretMaterial;
    update: UpdateSecretMaterial;
  };
  searchManager: Effect.Effect.Success<typeof RuntimeSearchManagerService>;
};

type SourceCatalogSyncServices =
  | ExecutorPluginRegistryService
  | RuntimeLocalScopeService
  | ExecutorStateStore
  | RuntimeSourceStoreService
  | LocalToolRuntimeLoaderService
  | ScopeConfigStore
  | ScopeStateStore
  | SourceArtifactStore
  | SourceTypeDeclarationsRefresherService
  | SecretMaterialResolverService
  | SecretMaterialStorerService
  | SecretMaterialDeleterService
  | SecretMaterialUpdaterService
  | RuntimeSearchManagerService;

export type RuntimeSourceCatalogSyncShape = {
  sync: (input: {
    source: Source;
    actorScopeId?: ScopeId | null;
  }) => Effect.Effect<void, Error, never>;
};

export class RuntimeSourceCatalogSyncService extends Context.Tag(
  "#runtime/RuntimeSourceCatalogSyncService",
)<RuntimeSourceCatalogSyncService, RuntimeSourceCatalogSyncShape>() {}

const ensureRuntimeCatalogSyncWorkspace = (
  deps: RuntimeSourceCatalogSyncDeps,
  scopeId: Source["scopeId"],
) =>
  Effect.gen(function* () {
    if (deps.runtimeLocalScope.installation.scopeId !== scopeId) {
      return yield* runtimeEffectError(
        "catalog/source/sync",
        `Runtime local scope mismatch: expected ${scopeId}, got ${deps.runtimeLocalScope.installation.scopeId}`,
      );
    }
  });

const sourceContributionRuntimeLayer = (
  deps: RuntimeSourceCatalogSyncDeps,
) =>
  Layer.mergeAll(
    Layer.succeed(ExecutorStateStore, deps.executorStateStore),
    Layer.succeed(LocalToolRuntimeLoaderService, deps.localToolRuntimeLoader),
    Layer.succeed(ScopeConfigStore, deps.scopeConfigStore),
    Layer.succeed(SecretMaterialResolverService, deps.secretMaterialServices.resolve),
    Layer.succeed(SecretMaterialStorerService, deps.secretMaterialServices.store),
    Layer.succeed(SecretMaterialDeleterService, deps.secretMaterialServices.delete),
    Layer.succeed(SecretMaterialUpdaterService, deps.secretMaterialServices.update),
  );

const syncSourceCatalogWithDeps = (
  deps: RuntimeSourceCatalogSyncDeps,
  input: {
    source: Source;
    actorScopeId?: ScopeId | null;
  },
): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    yield* ensureRuntimeCatalogSyncWorkspace(deps, input.source.scopeId);

    if (!shouldIndexSource(input.source)) {
      const state = yield* deps.scopeStateStore.load();
      const existingSourceState =
        state.sources[input.source.id] as LocalScopeState["sources"][string] | undefined;
      const nextState: LocalScopeState = {
        ...state,
        sources: {
          ...state.sources,
          [input.source.id]: {
            status: (input.source.enabled ? input.source.status : "draft") as SourceStatus,
            lastError: null,
            sourceHash: existingSourceState?.sourceHash ?? null,
            createdAt: existingSourceState?.createdAt ?? input.source.createdAt,
            updatedAt: Date.now(),
          },
        },
      };
      yield* deps.scopeStateStore.write({
        state: nextState,
      });
      yield* deps.sourceTypeDeclarationsRefresher.refreshSourceInBackground({
        source: input.source,
        snapshot: null,
      });
      yield* deps.searchManager.removeSource({
        sourceId: input.source.id,
        reason: input.source.enabled ? "not_connected" : "disabled",
      });
      return;
    }

    const definition = getSourceContributionForSource(
      deps.pluginRegistry,
      input.source,
    );
    const irModel = yield* definition.syncCatalog({
      source: input.source,
    }).pipe(Effect.provide(sourceContributionRuntimeLayer(deps)));
    const snapshot = snapshotFromSourceCatalogSyncResult(irModel);
    yield* deps.sourceArtifactStore.write({
      sourceId: input.source.id,
      artifact: deps.sourceArtifactStore.build({
        source: input.source,
        syncResult: irModel,
      }),
    });

    const state = yield* deps.scopeStateStore.load();
    const existingSourceState =
      state.sources[input.source.id] as LocalScopeState["sources"][string] | undefined;
    const nextState: LocalScopeState = {
      ...state,
      sources: {
        ...state.sources,
        [input.source.id]: {
          status: "connected",
          lastError: null,
          sourceHash: irModel.sourceHash,
          createdAt: existingSourceState?.createdAt ?? input.source.createdAt,
          updatedAt: Date.now(),
        },
      },
    };
    yield* deps.scopeStateStore.write({
      state: nextState,
    });

    yield* deps.sourceTypeDeclarationsRefresher.refreshSourceInBackground({
      source: input.source,
      snapshot,
    });

    const loaded = yield* loadSourceWithCatalog({
      scopeId: input.source.scopeId,
      sourceId: input.source.id,
    }).pipe(
      Effect.provideService(RuntimeLocalScopeService, deps.runtimeLocalScope),
      Effect.provideService(SourceArtifactStore, deps.sourceArtifactStore),
      Effect.provideService(RuntimeSourceStoreService, deps.sourceStore),
    );
    const indexedTools = yield* expandCatalogTools({
      catalogs: [loaded],
      includeSchemas: true,
      includeTypePreviews: true,
    });
    yield* deps.searchManager.syncSourceCatalog({
      source: input.source,
      providerKey: input.source.kind,
      revisionId: loaded.revision.id,
      sourceHash: irModel.sourceHash,
      generatedAt: loaded.revision.updatedAt,
      documents: indexedTools.map((tool) =>
        searchDocumentFromLoadedTool({
          path: tool.path,
          searchNamespace: tool.searchNamespace,
          searchText: tool.searchText,
          source: tool.source,
          sourceRecord: tool.sourceRecord,
          capabilityId: tool.capabilityId,
          executableId: tool.executableId,
          capability: tool.capability,
          executable: tool.executable,
          descriptor: tool.descriptor,
          projectedCatalog: tool.projectedCatalog,
        }),
      ),
    });
  }).pipe(
    Effect.withSpan("source.catalog.sync", {
      attributes: {
        "executor.source.id": input.source.id,
        "executor.source.kind": input.source.kind,
        "executor.source.namespace": input.source.namespace,
      },
    }),
  );

export const syncSourceCatalog = (input: {
  source: Source;
  actorScopeId?: ScopeId | null;
}): Effect.Effect<void, Error, SourceCatalogSyncServices> =>
  Effect.gen(function* () {
    const runtimeLocalScope = yield* RuntimeLocalScopeService;
    const pluginRegistry = yield* ExecutorPluginRegistryService;
    const executorStateStore = yield* ExecutorStateStore;
    const sourceStore = yield* RuntimeSourceStoreService;
    const localToolRuntimeLoader = yield* LocalToolRuntimeLoaderService;
    const scopeConfigStore = yield* ScopeConfigStore;
    const scopeStateStore = yield* ScopeStateStore;
    const sourceArtifactStore = yield* SourceArtifactStore;
    const sourceTypeDeclarationsRefresher =
      yield* SourceTypeDeclarationsRefresherService;
    const resolveSecretMaterial = yield* SecretMaterialResolverService;
    const storeSecretMaterial = yield* SecretMaterialStorerService;
    const deleteSecretMaterial = yield* SecretMaterialDeleterService;
    const updateSecretMaterial = yield* SecretMaterialUpdaterService;
    const searchManager = yield* RuntimeSearchManagerService;
    return yield* syncSourceCatalogWithDeps(
      {
        pluginRegistry,
        runtimeLocalScope,
        executorStateStore,
        sourceStore,
        localToolRuntimeLoader,
        scopeConfigStore,
        scopeStateStore,
        sourceArtifactStore,
        sourceTypeDeclarationsRefresher,
        secretMaterialServices: {
          resolve: resolveSecretMaterial,
          store: storeSecretMaterial,
          delete: deleteSecretMaterial,
          update: updateSecretMaterial,
        },
        searchManager,
      },
      {
        source: input.source,
        actorScopeId: input.actorScopeId,
      },
    );
  });

export const RuntimeSourceCatalogSyncLive = Layer.effect(
  RuntimeSourceCatalogSyncService,
  Effect.gen(function* () {
    const runtimeLocalScope = yield* RuntimeLocalScopeService;
    const pluginRegistry = yield* ExecutorPluginRegistryService;
    const executorStateStore = yield* ExecutorStateStore;
    const sourceStore = yield* RuntimeSourceStoreService;
    const localToolRuntimeLoader = yield* LocalToolRuntimeLoaderService;
    const scopeConfigStore = yield* ScopeConfigStore;
    const scopeStateStore = yield* ScopeStateStore;
    const sourceArtifactStore = yield* SourceArtifactStore;
    const sourceTypeDeclarationsRefresher =
      yield* SourceTypeDeclarationsRefresherService;
    const resolveSecretMaterial = yield* SecretMaterialResolverService;
    const storeSecretMaterial = yield* SecretMaterialStorerService;
    const deleteSecretMaterial = yield* SecretMaterialDeleterService;
    const updateSecretMaterial = yield* SecretMaterialUpdaterService;
    const searchManager = yield* RuntimeSearchManagerService;
    const deps: RuntimeSourceCatalogSyncDeps = {
      pluginRegistry,
      runtimeLocalScope,
      executorStateStore,
      sourceStore,
      localToolRuntimeLoader,
      scopeConfigStore,
      scopeStateStore,
      sourceArtifactStore,
      sourceTypeDeclarationsRefresher,
      secretMaterialServices: {
        resolve: resolveSecretMaterial,
        store: storeSecretMaterial,
        delete: deleteSecretMaterial,
        update: updateSecretMaterial,
      },
      searchManager,
    };

    return RuntimeSourceCatalogSyncService.of({
      sync: (input) => syncSourceCatalogWithDeps(deps, input),
    });
  }),
);
