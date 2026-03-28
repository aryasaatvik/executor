import { NodeFileSystem } from "@effect/platform-node";
import type {
  ControlPlaneOptions,
  ControlPlaneRuntimeLayer,
} from "@executor/core";
import { type RuntimeRegistryShape } from "@executor/core/ports";
import {
  ExecutionPolicyResolver,
  ExecutionSourceAdapterResolver,
  ExecutionEnvironmentResolver,
  ExecutionManager as ControlPlaneExecutionManager,
  RuntimeSourceCatalogStoreLive as ControlPlaneRuntimeSourceCatalogStoreLive,
  SourceCatalogStore as ControlPlaneSourceCatalogStore,
  createLiveExecutionManager,
  createWorkspaceExecutionEnvironmentResolver,
  makeWorkspaceSourceCatalogManager,
} from "@executor/core/services/execution";
import {
  SourceAuthMaterial as ControlPlaneSourceAuthMaterial,
  RuntimeSourceAuthMaterialLive,
} from "@executor/core/services/auth/source-auth-material";
import { RuntimeSourceCatalogSyncLive } from "@executor/core/services/catalog/catalog-sync";
import { EngineStore as ControlPlaneEngineStore } from "@executor/core/services/engine/store";
import {
  RuntimeLocalWorkspace as ControlPlaneRuntimeLocalWorkspace,
  type RuntimeLocalWorkspaceState as ControlPlaneRuntimeLocalWorkspaceState,
} from "@executor/core/services/engine/runtime-context";
import { WorkspaceConfigStore as ControlPlaneWorkspaceConfigStore } from "@executor/core/services/engine/local-storage";
import { WorkspaceDatabase as ControlPlaneWorkspaceDatabase } from "@executor/core/services/engine/workspace-database";
import { SecretMaterialStore as ControlPlaneSecretMaterialStore } from "@executor/core/services/engine/secret-material-store";
import { evaluateInvocationPolicy } from "@executor/core/services/policy/invocation-policy-engine";
import { loadRuntimeLocalWorkspacePolicies } from "@executor/core/services/policy/policies-operations";
import { getSourceAdapter } from "@executor/core/services/engine/source-adapters";
import {
  SourceStore as ControlPlaneSourceStore,
  RuntimeSourceStoreLive,
} from "@executor/core/services/sources/source-service";
import {
  SourceAuthService as ControlPlaneSourceAuthService,
  RuntimeSourceAuthServiceLive,
} from "@executor/core/services/sources/source-auth-service";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  RuntimeLocalWorkspace,
  RuntimeLocalWorkspaceLive,
  type RuntimeLocalWorkspaceState,
} from "./config/runtime-context";
import {
  WorkspaceConfigStore,
  LocalWorkspaceConfigStoreLive,
} from "./config/local-storage";
import {
  EngineStore,
  type EngineStoreShape,
} from "./stores/engine-store-types";
import {
  WorkspaceDatabase,
  WorkspaceDatabaseLive,
  makeWorkspaceDatabase,
} from "./stores/workspace-database";
import {
  SecretMaterialStore,
  SecretMaterialStoreLive,
  createDefaultSecretMaterialStorer,
} from "./stores/secret-material-store";
import {
  LocalToolRuntimeLoader,
  LocalToolRuntimeLoaderLive,
} from "./registry/tool-runtime-loader";
import {
  acquireLocalWorkspaceSourceCatalog,
  indexLocalWorkspaceToolsIntoSqlite,
} from "./search/source-catalog";
import { syncSourceToSqlite as syncLocalSourceToSqlite } from "./db/indexer";

const policyDecisionToLegacyShape = (
  decision: ReturnType<typeof evaluateInvocationPolicy>,
): {
  kind: "allow" | "deny" | "ask";
  reason: string;
} => ({
  kind: decision.kind === "require_interaction" ? "ask" : decision.kind,
  reason: decision.reason,
});

export type LocalRuntimeLayerOptions = Pick<
  ControlPlaneOptions,
  "executionResolver" | "resolveSecretMaterial" | "getLocalServerBaseUrl"
> & {
  readonly store: EngineStoreShape;
  readonly runtimeRegistry: RuntimeRegistryShape;
  readonly localWorkspaceState: RuntimeLocalWorkspaceState;
};

export const createLocalRuntimeLayer = (
  input: LocalRuntimeLayerOptions,
): ControlPlaneRuntimeLayer => {
  const liveExecutionManager = createLiveExecutionManager();
  const runtimeLocalWorkspaceState =
    input.localWorkspaceState as ControlPlaneRuntimeLocalWorkspaceState;
  const workspaceDatabase = makeWorkspaceDatabase(input.localWorkspaceState);

  const foundationLayer = Layer.mergeAll(
    RuntimeLocalWorkspaceLive(input.localWorkspaceState),
    Layer.succeed(EngineStore, input.store),
    Layer.succeed(
      ControlPlaneEngineStore,
      input.store as Effect.Effect.Success<typeof ControlPlaneEngineStore>,
    ),
    Layer.succeed(ControlPlaneRuntimeLocalWorkspace, runtimeLocalWorkspaceState),
    Layer.succeed(ControlPlaneExecutionManager, liveExecutionManager),
  );

  const platformLayer = NodeFileSystem.layer;

  const localWorkspaceConfigLayer = LocalWorkspaceConfigStoreLive.pipe(
    Layer.provide(platformLayer),
  );

  const localToolRuntimeLayer = LocalToolRuntimeLoaderLive.pipe(
    Layer.provide(platformLayer),
  );

  const controlPlaneWorkspaceConfigLayer = Layer.effect(
    ControlPlaneWorkspaceConfigStore,
    Effect.map(
      WorkspaceConfigStore,
      (service) =>
        service as Effect.Effect.Success<typeof ControlPlaneWorkspaceConfigStore>,
    ),
  );

  const filesystemLayer = Layer.mergeAll(
    platformLayer,
    localWorkspaceConfigLayer,
    localToolRuntimeLayer,
    controlPlaneWorkspaceConfigLayer,
  );

  const worldWorkspaceDatabaseLayer = WorkspaceDatabaseLive.pipe(
    Layer.provide(foundationLayer),
  );

  const controlPlaneWorkspaceDatabaseLayer = Layer.effect(
    ControlPlaneWorkspaceDatabase,
    Effect.map(
      WorkspaceDatabase,
      (service) =>
        service as Effect.Effect.Success<typeof ControlPlaneWorkspaceDatabase>,
    ),
  );

  const executionSourceAdapterResolverLayer = Layer.succeed(
    ExecutionSourceAdapterResolver,
    ExecutionSourceAdapterResolver.of({
      getSourceAdapter,
    }),
  );

  const executionPolicyResolverLayer = Layer.succeed(
    ExecutionPolicyResolver,
    ExecutionPolicyResolver.of({
      evaluateInvocationPolicy: (policyInput) =>
        policyDecisionToLegacyShape(evaluateInvocationPolicy(policyInput as never)),
      loadRuntimeLocalWorkspacePolicies: (workspaceId) =>
        loadRuntimeLocalWorkspacePolicies(workspaceId).pipe(
          Effect.provideService(
            ControlPlaneRuntimeLocalWorkspace,
            runtimeLocalWorkspaceState,
          ),
          Effect.provideService(
            ControlPlaneWorkspaceDatabase,
            workspaceDatabase as Effect.Effect.Success<
              typeof ControlPlaneWorkspaceDatabase
            >,
          ),
          Effect.map(({ policies }) => ({ policies })),
        ),
    }),
  );

  const worldSecretMaterialLayer = SecretMaterialStoreLive({
    resolveSecretMaterial: input.resolveSecretMaterial,
    localConfig: input.localWorkspaceState.loadedConfig.config,
    workspaceRoot: input.localWorkspaceState.context.workspaceRoot,
  }).pipe(
    Layer.provide(Layer.mergeAll(foundationLayer, filesystemLayer)),
  );

  const controlPlaneSecretMaterialLayer = Layer.effect(
    ControlPlaneSecretMaterialStore,
    Effect.gen(function* () {
      const secretMaterialStore = yield* SecretMaterialStore;
      const rows = yield* EngineStore;

      return ControlPlaneSecretMaterialStore.of({
        resolve: secretMaterialStore.resolve,
        getById: (id) =>
          rows.secretMaterials.getById(id).pipe(
            Effect.map((materialOption) =>
              Option.map(materialOption, (material) => ({
                id: material.id,
                providerId: material.providerId,
                name: material.name,
                purpose: material.purpose,
                createdAt: material.createdAt,
                updatedAt: material.updatedAt,
              })),
            ),
          ),
        listAll: () => rows.secretMaterials.listAll(),
        store: ({ providerId, ...secretInput }) =>
          providerId === undefined
            ? secretMaterialStore.store(secretInput)
            : createDefaultSecretMaterialStorer({
                rows,
                storeProviderId: providerId as Parameters<
                  typeof createDefaultSecretMaterialStorer
                >[0]["storeProviderId"],
              })(secretInput),
        update: secretMaterialStore.update,
        remove: secretMaterialStore.remove,
      });
    }),
  );

  const controlPlaneSourceStoreLayer = RuntimeSourceStoreLive.pipe(
    Layer.provide(Layer.mergeAll(foundationLayer, filesystemLayer)),
  );

  const controlPlaneSourceCatalogStoreLayer = ControlPlaneRuntimeSourceCatalogStoreLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        foundationLayer,
        controlPlaneSourceStoreLayer,
        controlPlaneWorkspaceDatabaseLayer,
      ),
    ),
  );

  const controlPlaneSourceAuthMaterialLayer = RuntimeSourceAuthMaterialLive.pipe(
    Layer.provide(
      Layer.mergeAll(foundationLayer, controlPlaneSecretMaterialLayer),
    ),
  );

  const controlPlaneSourceCatalogSyncLayer = RuntimeSourceCatalogSyncLive({
    syncSourceToSqlite: syncLocalSourceToSqlite,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        foundationLayer,
        controlPlaneSourceAuthMaterialLayer,
        controlPlaneSecretMaterialLayer,
        controlPlaneWorkspaceDatabaseLayer,
      ),
    ),
  );

  const controlPlaneSourceAuthServiceLayer = RuntimeSourceAuthServiceLive({
    getLocalServerBaseUrl: input.getLocalServerBaseUrl,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        foundationLayer,
        controlPlaneSourceStoreLayer,
        controlPlaneSourceCatalogSyncLayer,
        controlPlaneSecretMaterialLayer,
      ),
    ),
  );

  const executionResolverLayer = input.executionResolver
    ? Layer.succeed(ExecutionEnvironmentResolver, input.executionResolver)
    : Layer.effect(
        ExecutionEnvironmentResolver,
        Effect.gen(function* () {
          const sourceAuthMaterialService = yield* ControlPlaneSourceAuthMaterial;
          const sourceCatalogStore = yield* ControlPlaneSourceCatalogStore;
          const workspaceConfigStore = yield* ControlPlaneWorkspaceConfigStore;
          const localToolRuntimeLoader = yield* LocalToolRuntimeLoader;
          const secretMaterialStore = yield* ControlPlaneSecretMaterialStore;
          const workspaceSourceCatalogManager =
            yield* makeWorkspaceSourceCatalogManager({
              indexWorkspaceToolsIntoSqlite: ({
                workspaceId,
                accountId,
                sourceCatalogStore,
                workspaceConfigStore: _workspaceConfigStore,
                runtimeLocalWorkspace,
                embedder,
              }) =>
                indexLocalWorkspaceToolsIntoSqlite({
                  workspaceId,
                  accountId,
                  sourceCatalogStore: sourceCatalogStore as Parameters<
                    typeof indexLocalWorkspaceToolsIntoSqlite
                  >[0]["sourceCatalogStore"],
                  runtimeLocalWorkspace: runtimeLocalWorkspace as RuntimeLocalWorkspaceState,
                  embedder: embedder as Parameters<
                    typeof indexLocalWorkspaceToolsIntoSqlite
                  >[0]["embedder"],
                }),
              acquireWorkspaceSourceCatalog: ({
                workspaceId: _workspaceId,
                accountId: _accountId,
                sourceCatalogStore: _sourceCatalogStore,
                workspaceConfigStore: _workspaceConfigStore,
                runtimeLocalWorkspace,
                embedder,
              }) =>
                acquireLocalWorkspaceSourceCatalog({
                  runtimeLocalWorkspace: runtimeLocalWorkspace as RuntimeLocalWorkspaceState,
                  embedder: embedder as Parameters<
                    typeof acquireLocalWorkspaceSourceCatalog
                  >[0]["embedder"],
                }),
            });

          return createWorkspaceExecutionEnvironmentResolver({
            resolveSecretMaterial: secretMaterialStore.resolve,
            sourceAuthMaterialService,
            sourceCatalogStore,
            runtimeRegistry: input.runtimeRegistry,
            localToolRuntimeLoader,
            workspaceConfigStore,
            dependencies: {
              getRuntimeLocalWorkspaceOption: () =>
                Effect.succeed(input.localWorkspaceState),
              workspaceSourceCatalogManager,
            },
          });
        }),
      );

  const runtimeLayer = Layer.mergeAll(
    foundationLayer,
    filesystemLayer,
    worldWorkspaceDatabaseLayer,
    controlPlaneWorkspaceDatabaseLayer,
    worldSecretMaterialLayer,
    controlPlaneSecretMaterialLayer,
    controlPlaneSourceStoreLayer,
    controlPlaneSourceCatalogStoreLayer,
    controlPlaneSourceAuthMaterialLayer,
    controlPlaneSourceCatalogSyncLayer,
    controlPlaneSourceAuthServiceLayer,
    executionSourceAdapterResolverLayer,
    executionPolicyResolverLayer,
    executionResolverLayer,
  ) as ControlPlaneRuntimeLayer;

  return runtimeLayer;
};
