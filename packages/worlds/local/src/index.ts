import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { NodeFileSystem } from "@effect/platform-node";
import type {
  ControlPlane,
  ControlPlaneOptions,
  ControlPlaneRuntimeLayer,
} from "@executor/control-plane";
import {
  ExecutionStore,
  SourceStore,
  CatalogStore,
  SecretStore,
  AuthArtifactStore,
  SemanticSearch,
  InteractionBus,
  RuntimeRegistry,
  WorkspaceConfig,
} from "@executor/control-plane/ports";
import type { ExecutorWorld } from "@executor/control-plane/world";

import { createSqliteExecutionStore } from "./stores/execution-store";
import { createSqliteSourceStore } from "./stores/source-store";
import { createSqliteCatalogStore } from "./stores/catalog-store";
import { createLocalSecretStore } from "./stores/secret-store";
import { createSqliteAuthStore } from "./stores/auth-artifact-store";
import { createSqliteVecSearch } from "./search/semantic-search";
import { createInMemoryInteractionBus } from "./bus/interaction-bus";
import { createLocalRuntimeRegistry } from "./registry/runtime-registry";
import { createLocalWorkspaceConfig } from "./config/workspace-config";
import { resolveLocalWorkspaceContext } from "./config/config";
import { LocalWorkspaceConfigStore } from "./config/local-storage";
import { getOrProvisionLocalInstallation } from "./config/installation";
import { createLocalEnginePersistence } from "./stores/engine-store";
import { createLocalRuntimeLayer } from "./runtime-layer";

export interface LocalConfig {
  readonly dataDir: string;
  readonly cwd?: string;
  readonly workspaceRoot?: string;
}

export const createLocalWorld = (config: LocalConfig): ExecutorWorld => ({
  executionStore: createSqliteExecutionStore(),
  sourceStore: createSqliteSourceStore(),
  catalogStore: createSqliteCatalogStore(),
  secretStore: createLocalSecretStore(),
  authStore: createSqliteAuthStore(),
  search: createSqliteVecSearch(),
  interactions: createInMemoryInteractionBus(),
  runtimes: createLocalRuntimeRegistry(),
  config: createLocalWorkspaceConfig({
    cwd: config.cwd,
    workspaceRoot: config.workspaceRoot,
  }),

  start: () => Effect.void,
  close: () => Effect.void,
});

const worldToPortLayers = (world: ExecutorWorld) =>
  Layer.mergeAll(
    Layer.succeed(ExecutionStore, world.executionStore),
    Layer.succeed(SourceStore, world.sourceStore),
    Layer.succeed(CatalogStore, world.catalogStore),
    Layer.succeed(SecretStore, world.secretStore),
    Layer.succeed(AuthArtifactStore, world.authStore),
    Layer.succeed(SemanticSearch, world.search),
    Layer.succeed(InteractionBus, world.interactions),
    Layer.succeed(RuntimeRegistry, world.runtimes),
    Layer.succeed(WorkspaceConfig, world.config),
  );

export type LocalControlPlaneOptions = ControlPlaneOptions & {
  readonly cwd?: string;
};

export const createLocalControlPlane = (
  options: LocalControlPlaneOptions = {},
): Effect.Effect<ControlPlane, Error> =>
  Effect.gen(function* () {
    const baseWorld = createLocalWorld({
      dataDir: options.localDataDir ?? ":memory:",
      cwd: options.cwd,
      workspaceRoot: options.workspaceRoot,
    });

    if (baseWorld.start) {
      yield* baseWorld.start();
    }

    const context = yield* resolveLocalWorkspaceContext({
      cwd: options.cwd,
      workspaceRoot: options.workspaceRoot,
      homeConfigPath: options.homeConfigPath,
      homeStateDirectory: options.homeStateDirectory,
    }).pipe(Effect.provide(NodeFileSystem.layer));

    const installation = yield* getOrProvisionLocalInstallation({ context });
    const persistence = yield* createLocalEnginePersistence(context);
    const loadedConfig = yield* LocalWorkspaceConfigStore.load(context);

    const runtimeLocalWorkspaceState = {
      context,
      installation,
      loadedConfig,
    };

    const world = {
      ...baseWorld,
      executionStore: createSqliteExecutionStore(persistence.rows),
    } satisfies ExecutorWorld;

    const { runtimeLayer: nativeRuntimeLayer, apiLayer } = createLocalRuntimeLayer({
      executionResolver: options.executionResolver,
      resolveSecretMaterial: options.resolveSecretMaterial,
      getLocalServerBaseUrl: options.getLocalServerBaseUrl,
      store: persistence.rows,
      runtimeRegistry: world.runtimes,
      localWorkspaceState: runtimeLocalWorkspaceState,
    });

    const runtimeLayer = Layer.mergeAll(
      nativeRuntimeLayer,
      worldToPortLayers(world),
    ) as ControlPlaneRuntimeLayer;

    const managedRuntime = ManagedRuntime.make(runtimeLayer);
    yield* managedRuntime.runtimeEffect;

    return {
      installation,
      runtimeLayer,
      managedRuntime,
      apiLayer,
      close: async () => {
        if (world.close) {
          await Effect.runPromise(world.close()).catch(() => undefined);
        }
        await managedRuntime.dispose().catch(() => undefined);
        await persistence.close().catch(() => undefined);
      },
    } satisfies ControlPlane;
  });

export {
  resolveLocalWorkspaceContext,
  loadLocalExecutorConfig,
  type LoadedLocalExecutorConfig,
  type ResolvedLocalWorkspaceContext,
} from "./config/config";

export {
  type LocalInstallation,
  LocalInstallationSchema,
  deriveLocalInstallation,
  loadLocalInstallation,
  getOrProvisionLocalInstallation,
} from "./config/installation";

export {
  InstallationStore,
  WorkspaceConfigStore,
  LocalInstallationStore,
  LocalWorkspaceConfigStore,
  LocalStorageLive,
  WorkspaceStorageLive,
  makeLocalStorageLayer,
  makeWorkspaceStorageLayer,
  type InstallationStoreShape,
  type WorkspaceConfigStoreShape,
} from "./config/local-storage";

export {
  RuntimeLocalWorkspace,
  RuntimeLocalWorkspaceLive,
  provideOptionalRuntimeLocalWorkspace,
  getRuntimeLocalWorkspaceOption,
  requireRuntimeLocalWorkspace,
  requireRuntimeLocalAccountId,
  type RuntimeLocalWorkspaceState,
} from "./config/runtime-context";

export {
  createLocalEnginePersistence,
  type LocalEnginePersistence,
  type LocalEngineStore,
} from "./stores/engine-store";

export {
  WorkspaceDatabase,
  WorkspaceDatabaseLive,
  makeWorkspaceDatabase,
  workspaceDatabasePath,
  type WorkspaceDatabaseShape,
} from "./stores/workspace-database";

export {
  ENV_SECRET_PROVIDER_ID,
  KEYCHAIN_SECRET_PROVIDER_ID,
  LOCAL_SECRET_PROVIDER_ID,
  parseSecretStoreProviderId,
  resolveDefaultSecretStoreProviderId,
  createDefaultSecretMaterialStorer,
  createDefaultSecretMaterialUpdater,
  createDefaultSecretMaterialDeleter,
  SecretMaterialStore,
  SecretMaterialStoreLive,
  SecretMaterialLive,
  type SecretMaterialStoreShape,
  type ResolveSecretMaterial,
} from "./stores/secret-material-store";

export {
  LocalToolRuntimeLoader,
  LocalToolRuntimeLoaderLive,
  type LocalToolRuntime,
  type LocalToolRuntimeLoaderShape,
} from "./registry/tool-runtime-loader";
