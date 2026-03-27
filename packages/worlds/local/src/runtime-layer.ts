import { NodeFileSystem } from "@effect/platform-node";
import type {
  ControlPlaneOptions,
  ControlPlaneRuntimeLayer,
} from "@executor/control-plane";
import { type RuntimeRegistryShape } from "@executor/control-plane/ports";
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
import { RuntimeSourceCatalogSyncLive } from "@executor/control-plane/services/catalog/catalog-sync";
import { EngineStore as ControlPlaneEngineStore } from "@executor/control-plane/services/engine/store";
import {
  RuntimeLocalWorkspace as ControlPlaneRuntimeLocalWorkspace,
  type RuntimeLocalWorkspaceState as ControlPlaneRuntimeLocalWorkspaceState,
} from "@executor/control-plane/services/engine/runtime-context";
import { WorkspaceConfigStore as ControlPlaneWorkspaceConfigStore } from "@executor/control-plane/services/engine/local-storage";
import { WorkspaceDatabase as ControlPlaneWorkspaceDatabase } from "@executor/control-plane/services/engine/workspace-database";
import { SecretMaterialStore as ControlPlaneSecretMaterialStore } from "@executor/control-plane/services/engine/secret-material-store";
import { evaluateInvocationPolicy } from "@executor/control-plane/services/policy/invocation-policy-engine";
import { loadRuntimeLocalWorkspacePolicies } from "@executor/control-plane/services/policy/policies-operations";
import { getSourceAdapter } from "@executor/control-plane/services/engine/source-adapters";
import {
  SourceStore as ControlPlaneSourceStore,
  RuntimeSourceStoreLive,
} from "@executor/control-plane/services/sources/source-service";
import {
  SourceAuthService as ControlPlaneSourceAuthService,
  RuntimeSourceAuthServiceLive,
} from "@executor/control-plane/services/sources/source-auth-service";
import {
  createEngineApiLayer,
  EngineStore as EngineStoreTag,
  ExecutionManager as EngineExecutionManager,
  RuntimeLocalWorkspace as EngineRuntimeLocalWorkspace,
  RuntimeSourceCatalogStoreLive,
  SourceAuthService as EngineSourceAuthService,
  SourceCatalogStore as EngineSourceCatalogStore,
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
  makeWorkspaceDatabase,
} from "./stores/workspace-database";
import {
  SecretMaterialStore,
  SecretMaterialStoreLive,
} from "./stores/secret-material-store";
import {
  LocalToolRuntimeLoader,
  LocalToolRuntimeLoaderLive,
} from "./registry/tool-runtime-loader";

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
): {
  runtimeLayer: ControlPlaneRuntimeLayer;
  apiLayer: ReturnType<typeof createEngineApiLayer>;
} => {
  const liveExecutionManager = createLiveExecutionManager();
  const runtimeLocalWorkspaceState =
    input.localWorkspaceState as ControlPlaneRuntimeLocalWorkspaceState;
  const workspaceDatabase = makeWorkspaceDatabase(input.localWorkspaceState);

  setSourceAdapterResolver(
    getSourceAdapter as Parameters<typeof setSourceAdapterResolver>[0],
  );
  setPolicyResolver({
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
  });

  const foundationLayer = Layer.mergeAll(
    RuntimeLocalWorkspaceLive(input.localWorkspaceState),
    Layer.succeed(EngineStore, input.store),
    Layer.succeed(
      ControlPlaneEngineStore,
      input.store as Effect.Effect.Success<typeof ControlPlaneEngineStore>,
    ),
    Layer.succeed(
      EngineStoreTag,
      input.store as Effect.Effect.Success<typeof EngineStoreTag>,
    ),
    Layer.succeed(ControlPlaneRuntimeLocalWorkspace, runtimeLocalWorkspaceState),
    Layer.succeed(
      EngineRuntimeLocalWorkspace,
      runtimeLocalWorkspaceState as Effect.Effect.Success<
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

  const controlPlaneWorkspaceConfigLayer = Layer.effect(
    ControlPlaneWorkspaceConfigStore,
    Effect.map(
      WorkspaceConfigStore,
      (service) =>
        service as Effect.Effect.Success<typeof ControlPlaneWorkspaceConfigStore>,
    ),
  );

  const engineWorkspaceConfigLayer = Layer.effect(
    EngineWorkspaceConfigStore,
    Effect.map(
      WorkspaceConfigStore,
      (service) =>
        service as Effect.Effect.Success<typeof EngineWorkspaceConfigStore>,
    ),
  );

  const filesystemLayer = Layer.mergeAll(
    platformLayer,
    localWorkspaceConfigLayer,
    localToolRuntimeLayer,
    controlPlaneWorkspaceConfigLayer,
    engineWorkspaceConfigLayer,
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

  const engineWorkspaceDatabaseLayer = Layer.effect(
    EngineWorkspaceDatabase,
    Effect.map(
      WorkspaceDatabase,
      (service) =>
        service as Effect.Effect.Success<typeof EngineWorkspaceDatabase>,
    ),
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
    Effect.map(
      SecretMaterialStore,
      (service) =>
        service as Effect.Effect.Success<typeof ControlPlaneSecretMaterialStore>,
    ),
  );

  const controlPlaneSourceStoreLayer = RuntimeSourceStoreLive.pipe(
    Layer.provide(Layer.mergeAll(foundationLayer, filesystemLayer)),
  );

  const engineSourceStoreLayer = Layer.effect(
    EngineSourceStore,
    Effect.map(
      ControlPlaneSourceStore,
      (service) =>
        service as Effect.Effect.Success<typeof EngineSourceStore>,
    ),
  );

  const engineSourceCatalogStoreLayer = RuntimeSourceCatalogStoreLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        foundationLayer,
        engineSourceStoreLayer,
        engineWorkspaceDatabaseLayer,
      ),
    ),
  );

  const controlPlaneSourceAuthMaterialLayer = RuntimeSourceAuthMaterialLive.pipe(
    Layer.provide(
      Layer.mergeAll(foundationLayer, controlPlaneSecretMaterialLayer),
    ),
  );

  const controlPlaneSourceCatalogSyncLayer = RuntimeSourceCatalogSyncLive.pipe(
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

  const engineSourceAuthServiceLayer = Layer.effect(
    EngineSourceAuthService,
    Effect.map(
      ControlPlaneSourceAuthService,
      (service) =>
        service as Effect.Effect.Success<typeof EngineSourceAuthService>,
    ),
  );

  const executionResolverLayer = input.executionResolver
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

          return createWorkspaceExecutionEnvironmentResolver({
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
          });
        }),
      );

  const runtimeLayer = Layer.mergeAll(
    foundationLayer,
    filesystemLayer,
    worldWorkspaceDatabaseLayer,
    controlPlaneWorkspaceDatabaseLayer,
    engineWorkspaceDatabaseLayer,
    worldSecretMaterialLayer,
    controlPlaneSecretMaterialLayer,
    controlPlaneSourceStoreLayer,
    engineSourceStoreLayer,
    engineSourceCatalogStoreLayer,
    controlPlaneSourceAuthMaterialLayer,
    controlPlaneSourceCatalogSyncLayer,
    controlPlaneSourceAuthServiceLayer,
    engineSourceAuthServiceLayer,
    executionResolverLayer,
  ) as ControlPlaneRuntimeLayer;

  return {
    runtimeLayer,
    apiLayer: createEngineApiLayer(runtimeLayer),
  };
};
