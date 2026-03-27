import { NodeFileSystem } from "@effect/platform-node";
import type {
  ControlPlaneOptions,
  ControlPlaneRuntimeLayer,
} from "@executor/control-plane";
import { type RuntimeRegistryShape } from "@executor/control-plane/ports/runtime-registry";
import {
  ExecutionEnvironmentResolver,
  ExecutionManager as ControlPlaneExecutionManager,
  createLiveExecutionManager,
  createWorkspaceExecutionEnvironmentResolver,
  makeWorkspaceSourceCatalogManager,
  setPolicyResolver,
  setSourceAdapterResolver,
} from "@executor/control-plane/services/execution";
import {
  SourceAuthMaterial as ControlPlaneSourceAuthMaterial,
  RuntimeSourceAuthMaterialLive,
} from "@executor/control-plane/services/auth/source-auth-material";
import {
  SourceCatalogSync as ControlPlaneSourceCatalogSync,
  RuntimeSourceCatalogSyncLive,
} from "@executor/control-plane/services/catalog/catalog-sync";
import {
  EngineStore as ControlPlaneEngineStore,
  type EngineStoreShape as ControlPlaneEngineStoreShape,
} from "@executor/control-plane/services/engine/store";
import {
  RuntimeLocalWorkspace as ControlPlaneRuntimeLocalWorkspace,
  type RuntimeLocalWorkspaceState as ControlPlaneRuntimeLocalWorkspaceState,
} from "@executor/control-plane/services/engine/runtime-context";
import {
  WorkspaceConfigStore as ControlPlaneWorkspaceConfigStore,
  type WorkspaceConfigStoreShape as ControlPlaneWorkspaceConfigStoreShape,
} from "@executor/control-plane/services/engine/local-storage";
import {
  WorkspaceDatabase as ControlPlaneWorkspaceDatabase,
  type WorkspaceDatabaseShape as ControlPlaneWorkspaceDatabaseShape,
} from "@executor/control-plane/services/engine/workspace-database";
import {
  SecretMaterialStore as ControlPlaneSecretMaterialStore,
  type SecretMaterialStoreShape as ControlPlaneSecretMaterialStoreShape,
} from "@executor/control-plane/services/engine/secret-material-store";
import {
  evaluateInvocationPolicy,
} from "@executor/control-plane/services/policy/invocation-policy-engine";
import {
  loadRuntimeLocalWorkspacePolicies,
} from "@executor/control-plane/services/policy/policies-operations";
import {
  getSourceAdapter,
} from "@executor/control-plane/services/engine/source-adapters";
import {
  SourceStore as ControlPlaneSourceStore,
  type RuntimeSourceStore as ControlPlaneRuntimeSourceStore,
  RuntimeSourceStoreLive,
} from "@executor/control-plane/services/sources/source-service";
import {
  SourceAuthService as ControlPlaneSourceAuthService,
  RuntimeSourceAuthServiceLive,
  type RuntimeSourceAuthService,
} from "@executor/control-plane/services/sources/source-auth-service";
import {
  createEngineApiLayer,
  EngineStore as EngineStoreTag,
  ExecutionManager as EngineExecutionManager,
  RuntimeLocalWorkspace as EngineRuntimeLocalWorkspace,
  RuntimeSourceCatalogStoreLive,
  SourceAuthService as EngineSourceAuthService,
  SourceCatalogStore as EngineSourceCatalogStore,
  SourceCatalogSync as EngineSourceCatalogSync,
  SourceStore as EngineSourceStore,
  WorkspaceConfigStore as EngineWorkspaceConfigStore,
  WorkspaceDatabase as EngineWorkspaceDatabase,
} from "@executor/engine";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
} from "./stores/workspace-database";
import {
  SecretMaterialStore,
  SecretMaterialStoreLive,
} from "./stores/secret-material-store";
import {
  LocalToolRuntimeLoader,
  LocalToolRuntimeLoaderLive,
} from "./registry/tool-runtime-loader";

const bridgeService = (
  service: Effect.Effect<any, never, never>,
  tag: { of: (service: any) => any },
) =>
  Layer.effect(tag as never, Effect.map(service, (value) => tag.of(value)));

const policyDecisionToLegacyShape = (
  decision: ReturnType<typeof evaluateInvocationPolicy>,
): {
  kind: "allow" | "deny" | "ask";
  reason: string;
} => ({
  kind:
    decision.kind === "require_interaction"
      ? "ask"
      : decision.kind,
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
): {
  runtimeLayer: ControlPlaneRuntimeLayer;
  apiLayer: ReturnType<typeof createEngineApiLayer>;
} => {
  setSourceAdapterResolver(getSourceAdapter);
  setPolicyResolver({
    evaluateInvocationPolicy: (policyInput) =>
      policyDecisionToLegacyShape(evaluateInvocationPolicy(policyInput as never)),
    loadRuntimeLocalWorkspacePolicies: (workspaceId) =>
      loadRuntimeLocalWorkspacePolicies(workspaceId).pipe(
        Effect.map(({ policies }) => ({ policies })),
      ),
  });

  const liveExecutionManager = createLiveExecutionManager();

  const runtimeLocalWorkspaceState =
    input.localWorkspaceState as ControlPlaneRuntimeLocalWorkspaceState;

  const tier1_foundation = Layer.mergeAll(
    RuntimeLocalWorkspaceLive(input.localWorkspaceState),
    Layer.succeed(EngineStore, input.store),
    Layer.succeed(
      ControlPlaneEngineStore,
      input.store as unknown as ControlPlaneEngineStoreShape,
    ),
    Layer.succeed(
      EngineStoreTag,
      input.store as unknown as Effect.Effect.Success<typeof EngineStoreTag>,
    ),
    Layer.succeed(ControlPlaneRuntimeLocalWorkspace, runtimeLocalWorkspaceState),
    Layer.succeed(
      EngineRuntimeLocalWorkspace,
      runtimeLocalWorkspaceState as unknown as Effect.Effect.Success<
        typeof EngineRuntimeLocalWorkspace
      >,
    ),
    Layer.succeed(ControlPlaneExecutionManager, liveExecutionManager),
    Layer.succeed(
      EngineExecutionManager,
      liveExecutionManager as unknown as Effect.Effect.Success<
        typeof EngineExecutionManager
      >,
    ),
  );

  const platformLayer = NodeFileSystem.layer;

  const localWorkspaceConfigLayer = LocalWorkspaceConfigStoreLive.pipe(
    Layer.provide(platformLayer),
  );

  const localToolRuntimeLayer = LocalToolRuntimeLoaderLive.pipe(
    Layer.provide(platformLayer),
  );

  const workspaceConfigBridgeLayer = Layer.mergeAll(
    bridgeService(WorkspaceConfigStore, ControlPlaneWorkspaceConfigStore),
    bridgeService(WorkspaceConfigStore, EngineWorkspaceConfigStore),
  );

  const tier2_filesystem = Layer.mergeAll(
    platformLayer,
    localWorkspaceConfigLayer,
    localToolRuntimeLayer,
    workspaceConfigBridgeLayer,
  );

  const worldWorkspaceDatabaseLayer = WorkspaceDatabaseLive.pipe(
    Layer.provide(tier1_foundation),
  );

  const workspaceDatabaseBridgeLayer = Layer.mergeAll(
    bridgeService(WorkspaceDatabase, ControlPlaneWorkspaceDatabase),
    bridgeService(WorkspaceDatabase, EngineWorkspaceDatabase),
  );

  const worldSecretMaterialLayer = SecretMaterialStoreLive({
    resolveSecretMaterial: input.resolveSecretMaterial,
    localConfig: input.localWorkspaceState.loadedConfig.config,
    workspaceRoot: input.localWorkspaceState.context.workspaceRoot,
  }).pipe(
    Layer.provide(Layer.mergeAll(tier1_foundation, tier2_filesystem)),
  );

  const controlPlaneSecretMaterialLayer = bridgeService(
    SecretMaterialStore.pipe(
      Effect.map(
        (service) =>
          service as unknown as ControlPlaneSecretMaterialStoreShape,
      ),
    ),
    ControlPlaneSecretMaterialStore,
  );

  const controlPlaneSourceStoreLayer = RuntimeSourceStoreLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        tier1_foundation,
        workspaceConfigBridgeLayer,
      ),
    ),
  );

  const engineSourceStoreBridgeLayer = bridgeService(
    ControlPlaneSourceStore.pipe(
      Effect.map(
        (service) =>
          service as unknown as Effect.Effect.Success<typeof EngineSourceStore>,
      ),
    ),
    EngineSourceStore,
  );

  const engineSourceCatalogStoreLayer = RuntimeSourceCatalogStoreLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        tier1_foundation,
        engineSourceStoreBridgeLayer,
        workspaceDatabaseBridgeLayer,
      ),
    ),
  );

  const controlPlaneSourceAuthMaterialLayer = RuntimeSourceAuthMaterialLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        tier1_foundation,
        controlPlaneSecretMaterialLayer,
      ),
    ),
  );

  const controlPlaneSourceCatalogSyncLayer = RuntimeSourceCatalogSyncLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        tier1_foundation,
        controlPlaneSourceAuthMaterialLayer,
        controlPlaneSecretMaterialLayer,
        workspaceDatabaseBridgeLayer,
      ),
    ),
  );

  const engineSourceCatalogSyncBridgeLayer = bridgeService(
    ControlPlaneSourceCatalogSync,
    EngineSourceCatalogSync,
  );

  const controlPlaneSourceAuthServiceLayer = RuntimeSourceAuthServiceLive({
    getLocalServerBaseUrl: input.getLocalServerBaseUrl,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        tier1_foundation,
        controlPlaneSourceStoreLayer,
        controlPlaneSourceCatalogSyncLayer,
        controlPlaneSecretMaterialLayer,
      ),
    ),
  );

  const engineSourceAuthServiceBridgeLayer = bridgeService(
    ControlPlaneSourceAuthService.pipe(
      Effect.map(
        (service) =>
          service as unknown as Effect.Effect.Success<typeof EngineSourceAuthService>,
      ),
    ),
    EngineSourceAuthService,
  );

  const executionResolverLayer =
    input.executionResolver
      ? Layer.succeed(ExecutionEnvironmentResolver, input.executionResolver)
      : Layer.effect(
          ExecutionEnvironmentResolver,
          Effect.gen(function* () {
            const sourceAuthMaterialService = yield* ControlPlaneSourceAuthMaterial;
            const sourceAuthService = yield* ControlPlaneSourceAuthService;
            const sourceCatalogStore = yield* EngineSourceCatalogStore;
            const sourceStore = yield* ControlPlaneSourceStore;
            const workspaceConfigStore = yield* ControlPlaneWorkspaceConfigStore;
            const localToolRuntimeLoader = yield* LocalToolRuntimeLoader;
            const secretMaterialStore = yield* ControlPlaneSecretMaterialStore;
            const workspaceSourceCatalogManager =
              yield* makeWorkspaceSourceCatalogManager();

            return ExecutionEnvironmentResolver.of(
              createWorkspaceExecutionEnvironmentResolver({
                resolveSecretMaterial: secretMaterialStore.resolve,
                sourceAuthMaterialService,
                sourceAuthService,
                sourceCatalogStore,
                sourceStore,
                runtimeRegistry: input.runtimeRegistry,
                localToolRuntimeLoader,
                workspaceConfigStore,
                dependencies: {
                  getRuntimeLocalWorkspaceOption: () =>
                    Effect.succeed(input.localWorkspaceState),
                  workspaceSourceCatalogManager,
                },
              }),
            );
          }),
        );

  const runtimeLayer = Layer.mergeAll(
    tier1_foundation,
    tier2_filesystem,
    worldWorkspaceDatabaseLayer,
    workspaceDatabaseBridgeLayer,
    worldSecretMaterialLayer,
    controlPlaneSecretMaterialLayer,
    controlPlaneSourceStoreLayer,
    engineSourceStoreBridgeLayer,
    engineSourceCatalogStoreLayer,
    controlPlaneSourceAuthMaterialLayer,
    controlPlaneSourceCatalogSyncLayer,
    engineSourceCatalogSyncBridgeLayer,
    controlPlaneSourceAuthServiceLayer,
    engineSourceAuthServiceBridgeLayer,
    executionResolverLayer,
  ) as ControlPlaneRuntimeLayer;

  return {
    runtimeLayer,
    apiLayer: createEngineApiLayer(runtimeLayer),
  };
};
