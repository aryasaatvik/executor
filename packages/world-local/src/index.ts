import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { NodeFileSystem } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { resolve } from "node:path";
import type {
  ControlPlane,
  ControlPlaneOptions,
  ControlPlaneRuntimeLayer,
} from "@executor/core";
import type { ExecutorWorld } from "@executor/core/world";

import { resolveLocalWorkspaceContext } from "./config/config";
import { LocalWorkspaceConfigStore } from "./config/local-storage";
import { getOrProvisionLocalInstallation } from "./config/installation";
import { createLocalEnginePersistence } from "./stores/engine-store";
import { createLocalRuntimeLayer } from "./runtime-layer";
import { createLocalRuntimeRegistry } from "./registry/runtime-registry";

// ---------------------------------------------------------------------------
// Local World — provides SQLite connection + optional vector/embedder
// ---------------------------------------------------------------------------

export interface LocalConfig {
  readonly dataDir: string;
  readonly cwd?: string;
  readonly workspaceRoot?: string;
}

/**
 * Create a local ExecutorWorld backed by SQLite.
 *
 * The world is thin — it provides a database connection layer.
 * Core owns all schema, queries, and business logic.
 */
export const createLocalWorld = (config: LocalConfig): ExecutorWorld => ({
  database: SqliteClient.layer({
    filename:
      config.dataDir === ":memory:"
        ? ":memory:"
        : resolve(config.dataDir, "executor.db"),
  }),
  // vectorSearch and embedder are optional — added when semantic search is configured
});

// ---------------------------------------------------------------------------
// Local Control Plane — full runtime bootstrap
// ---------------------------------------------------------------------------

export type LocalControlPlaneOptions = ControlPlaneOptions & {
  readonly cwd?: string;
};

export const createLocalControlPlane = (
  options: LocalControlPlaneOptions = {},
): Effect.Effect<ControlPlane, Error> =>
  Effect.gen(function* () {
    const world = createLocalWorld({
      dataDir: options.localDataDir ?? ":memory:",
      cwd: options.cwd,
      workspaceRoot: options.workspaceRoot,
    });

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

    const nativeRuntimeLayer = createLocalRuntimeLayer({
      executionResolver: options.executionResolver,
      resolveSecretMaterial: options.resolveSecretMaterial,
      getLocalServerBaseUrl: options.getLocalServerBaseUrl,
      store: persistence.rows,
      runtimeRegistry: createLocalRuntimeRegistry(),
      localWorkspaceState: runtimeLocalWorkspaceState,
    });

    const runtimeLayer = Layer.mergeAll(
      nativeRuntimeLayer,
      world.database,
    ) as unknown as ControlPlaneRuntimeLayer;

    const managedRuntime = ManagedRuntime.make(runtimeLayer);
    yield* managedRuntime.runtimeEffect;

    return {
      installation,
      runtimeLayer,
      managedRuntime,
      close: async () => {
        await managedRuntime.dispose().catch(() => undefined);
        await persistence.close().catch(() => undefined);
      },
    } satisfies ControlPlane;
  });

export {
  resolveLocalWorkspaceContext,
  loadLocalExecutorConfig,
  mergeLocalExecutorConfigs,
  writeHomeLocalExecutorConfig,
  writeProjectLocalExecutorConfig,
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

export {
  acquireLocalWorkspaceSourceCatalog,
  createLocalWorkspaceSourceCatalog,
  indexLocalWorkspaceToolsIntoSqlite,
} from "./search/source-catalog";
