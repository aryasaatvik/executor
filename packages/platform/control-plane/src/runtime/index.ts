import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import { NodeFileSystem } from "@effect/platform-node";
import { clearAllMcpConnectionPools } from "@executor/source-mcp";

import { type ControlPlaneApiRuntimeContext } from "#api";
import type { LocalInstallation } from "#schema";

import { type ResolveExecutionEnvironment } from "./execution/state";
import {
  createLiveExecutionManager,
  ExecutionManager,
} from "./execution/live";
import {
  createLocalControlPlanePersistence,
  type LocalControlPlanePersistence,
} from "./local/control-plane-store";

import {
  resolveLocalWorkspaceContext,
} from "./local/config";
import {
  LocalStorageLive,
  LocalInstallationStore,
  LocalWorkspaceConfigStore,
} from "./local/storage";
import {
  type RuntimeLocalWorkspaceState,
  RuntimeLocalWorkspaceLive,
} from "./local/runtime-context";
import { WorkspaceDatabaseLive } from "./local/workspace-database";
import { LocalToolRuntimeLoaderLive } from "./local/tools";
import { synchronizeLocalWorkspaceState } from "./local/workspace-sync";
import { ControlPlaneStore, type ControlPlaneStoreShape } from "./store";
import { RuntimeSourceStoreLive } from "./sources/source-store";
import { RuntimeSourceCatalogStoreLive } from "./catalog/source/runtime";
import { reconcileMissingSourceCatalogArtifacts } from "./catalog/source/reconcile";
import { RuntimeSourceAuthMaterialLive } from "./auth/source-auth-material";
import { RuntimeSourceCatalogSyncLive } from "./catalog/source/sync";
import {
  RuntimeSourceAuthServiceLive,
} from "./sources/source-auth-service";
import type { ResolveSecretMaterial } from "./local/secret-material-providers";
import { SecretMaterialStoreLive } from "./local/secret-material-providers";
import {
  RuntimeExecutionResolverLive,
} from "./execution/workspace/environment";

export * from "./execution/state";
export * from "./sources/executor-tools";
export * from "./execution/live";
export * from "./local/config";
export * from "./local/installation";
export * from "./local/storage";
export * from "./local/workspace-database";

export * from "./local/tools";
export * from "./catalog/schema-type-signature";
export * from "./sources/source-auth-service";
export * from "./local/secret-material-providers";
export * from "./sources/source-credential-interactions";
export * from "./sources/source-adapters/mcp";
export * from "./store";
export * from "./execution/workspace/environment";
export * from "./sources/source-inspection";
export * from "./sources/source-discovery";
export * from "./execution/service";

export type RuntimeControlPlaneOptions = {
  executionResolver?: ResolveExecutionEnvironment;
  resolveSecretMaterial?: ResolveSecretMaterial;
  getLocalServerBaseUrl?: () => string | undefined;
  localDataDir?: string;
  workspaceRoot?: string;
  homeConfigPath?: string;
  homeStateDirectory?: string;
};

const detailsFromCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const toLocalRuntimeBootstrapError = (
  cause: unknown,
): Error => {
  const details = detailsFromCause(cause);
  return new Error(`Failed initializing local runtime: ${details}`);
};

const closeScope = (scope: Scope.CloseableScope) =>
  Scope.close(scope, Exit.void).pipe(Effect.orDie);

export type RuntimeControlPlaneLayer = Layer.Layer<
  ControlPlaneApiRuntimeContext,
  never,
  never
>;

/**
 * Runtime layer composition — organized into explicit tiers.
 *
 * Dependency DAG (each tier depends only on previous tiers):
 *
 *   Tier 1 — Foundation
 *     ControlPlaneStore, RuntimeLocalWorkspace, LiveExecutionMgr
 *
 *   Tier 2 — Filesystem (minimal)
 *     FileSystem (platform), WorkspaceConfigStore, LocalToolRuntimeLoader
 *
 *   Tier 3 — Storage
 *     WorkspaceDatabase, SecretMaterial, SourceStore, CatalogStore
 *
 *   Tier 4 — Source
 *     SourceAuthMaterial, CatalogSync, SourceAuth
 *
 *   Tier 5 — Execution
 *     ExecutionResolver
 */
export const createRuntimeControlPlaneLayer = (
  input: RuntimeControlPlaneOptions & {
    store: ControlPlaneStoreShape;
    localWorkspaceState: RuntimeLocalWorkspaceState;
    liveExecutionManager: ReturnType<typeof createLiveExecutionManager>;
  },
) => {
  // ── Tier 1 — Foundation ──────────────────────────────────────────────
  // Pure data: store, workspace context, execution manager. No I/O deps.
  const tier1_foundation = Layer.mergeAll(
    Layer.succeed(ControlPlaneStore, input.store),
    RuntimeLocalWorkspaceLive(input.localWorkspaceState),
    Layer.succeed(ExecutionManager, input.liveExecutionManager),
  );

  // ── Tier 2 — Filesystem (minimal) ───────────────────────────────────
  // Only services that genuinely need file I/O: config store, tool loader.
  const platformLayer = NodeFileSystem.layer;

  const storageLayer = LocalStorageLive.pipe(
    Layer.provide(platformLayer),
  );

  const localToolRuntimeLayer = LocalToolRuntimeLoaderLive.pipe(
    Layer.provide(platformLayer),
  );

  const tier2_filesystem = Layer.mergeAll(
    platformLayer,
    storageLayer,
    localToolRuntimeLayer,
  );

  // Combined foundation for downstream tiers
  const tier1_2 = Layer.mergeAll(tier1_foundation, tier2_filesystem);

  // ── Tier 3 — Storage ────────────────────────────────────────────────
  // Workspace database, secret material, source store, catalog store.
  // Depend on Tier 1+2.
  const workspaceDatabaseLayer = WorkspaceDatabaseLive.pipe(
    Layer.provide(tier1_foundation),
  );

  const secretMaterialLayer = SecretMaterialStoreLive({
    resolveSecretMaterial: input.resolveSecretMaterial,
  }).pipe(Layer.provide(tier1_2));

  const sourceStoreLayer = RuntimeSourceStoreLive.pipe(
    Layer.provide(tier1_2),
  );

  const sourceCatalogStoreLayer = RuntimeSourceCatalogStoreLive.pipe(
    Layer.provide(Layer.mergeAll(tier1_2, sourceStoreLayer)),
  );

  const tier3_storage = Layer.mergeAll(
    workspaceDatabaseLayer,
    secretMaterialLayer,
    sourceStoreLayer,
    sourceCatalogStoreLayer,
  );

  // ── Tier 4 — Source ─────────────────────────────────────────────────
  // Auth material, catalog sync, source auth. Depend on Tier 1+2+3.
  const tier1_2_3 = Layer.mergeAll(tier1_2, tier3_storage);

  const sourceAuthMaterialLayer = RuntimeSourceAuthMaterialLive.pipe(
    Layer.provide(tier1_2_3),
  );

  const sourceCatalogSyncLayer = RuntimeSourceCatalogSyncLive.pipe(
    Layer.provide(Layer.mergeAll(tier1_2_3, sourceAuthMaterialLayer)),
  );

  const sourceAuthLayer = RuntimeSourceAuthServiceLive({
    getLocalServerBaseUrl: input.getLocalServerBaseUrl,
  }).pipe(
    Layer.provide(Layer.mergeAll(tier1_2_3, sourceCatalogSyncLayer)),
  );

  const tier4_source = Layer.mergeAll(
    sourceAuthMaterialLayer,
    sourceCatalogSyncLayer,
    sourceAuthLayer,
  );

  // ── Tier 5 — Execution ──────────────────────────────────────────────
  // ExecutionResolver depends on all previous tiers.
  const tier5_execution = RuntimeExecutionResolverLive({
    executionResolver: input.executionResolver,
  }).pipe(
    Layer.provide(Layer.mergeAll(tier1_2, tier3_storage, tier4_source)),
  );

  // ── Final composed layer ────────────────────────────────────────────
  return Layer.mergeAll(
    tier1_foundation,
    tier2_filesystem,
    tier3_storage,
    tier4_source,
    tier5_execution,
  ) as RuntimeControlPlaneLayer;
};

export type ControlPlaneRuntime = {
  persistence: LocalControlPlanePersistence;
  localInstallation: LocalInstallation;
  managedRuntime: ManagedRuntime.ManagedRuntime<ControlPlaneApiRuntimeContext, never>;
  runtimeLayer: RuntimeControlPlaneLayer;
  close: () => Promise<void>;
};

export const provideControlPlaneRuntime = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  runtime: ControlPlaneRuntime,
): Effect.Effect<A, E | never, Exclude<R, ControlPlaneApiRuntimeContext>> =>
  effect.pipe(Effect.provide(runtime.managedRuntime));

export const createControlPlaneRuntime = (
  options: RuntimeControlPlaneOptions,
): Effect.Effect<ControlPlaneRuntime, Error> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();

    const localWorkspaceContext = yield* resolveLocalWorkspaceContext({
      workspaceRoot: options.workspaceRoot,
      homeConfigPath: options.homeConfigPath,
      homeStateDirectory: options.homeStateDirectory,
    }).pipe(
      Effect.mapError(toLocalRuntimeBootstrapError),
      Effect.catchAll((error) =>
        closeScope(scope).pipe(Effect.zipRight(Effect.fail(error))),
      ),
    );


    const installationStore = LocalInstallationStore;
    const workspaceConfigStore = LocalWorkspaceConfigStore;

    const localInstallation = yield* installationStore.getOrProvision({
      context: localWorkspaceContext,
    }).pipe(
      Effect.mapError(toLocalRuntimeBootstrapError),
      Effect.catchAll((error) =>
        closeScope(scope).pipe(Effect.zipRight(Effect.fail(error))),
      ),
    );

    const persistence = yield* createLocalControlPlanePersistence(
      localWorkspaceContext,
    ).pipe(
      Effect.mapError(toLocalRuntimeBootstrapError),
      Effect.catchAll((error) =>
        closeScope(scope).pipe(Effect.zipRight(Effect.fail(error))),
      ),
    );
    const rows = persistence.rows;

    const loadedLocalConfig = yield* workspaceConfigStore.load(
      localWorkspaceContext,
    ).pipe(
      Effect.mapError(toLocalRuntimeBootstrapError),
      Effect.catchAll((error) =>
        closeScope(scope).pipe(Effect.zipRight(Effect.fail(error))),
      ),
    );

    const effectiveLocalConfig = yield* synchronizeLocalWorkspaceState({
      context: localWorkspaceContext,
      loadedConfig: loadedLocalConfig,
    }).pipe(
      Effect.mapError(toLocalRuntimeBootstrapError),
      Effect.catchAll((error) =>
        closeScope(scope).pipe(Effect.zipRight(Effect.fail(error))),
      ),
    );

    const runtimeLocalWorkspaceState: RuntimeLocalWorkspaceState = {
      context: localWorkspaceContext,
      installation: {
        workspaceId: localInstallation.workspaceId,
        accountId: localInstallation.accountId,
      },
      loadedConfig: {
        ...loadedLocalConfig,
        config: effectiveLocalConfig,
      },
    };
    const liveExecutionManager = createLiveExecutionManager();

    const concreteRuntimeLayer = createRuntimeControlPlaneLayer({
      ...options,
      store: rows,
      localWorkspaceState: runtimeLocalWorkspaceState,
      liveExecutionManager,
    });
    const managedRuntime = ManagedRuntime.make(concreteRuntimeLayer);
    yield* managedRuntime.runtimeEffect;
    yield* reconcileMissingSourceCatalogArtifacts({
      workspaceId: localInstallation.workspaceId,
      actorAccountId: localInstallation.accountId,
    }).pipe(
      Effect.provide(managedRuntime),
      Effect.catchAll((error) =>
        Effect.promise(() => managedRuntime.dispose())
          .pipe(
            Effect.catchAll(() => Effect.void),
            Effect.zipRight(closeScope(scope)),
            Effect.zipRight(Effect.fail(error)),
          ),
      ),
    );

    return {
      persistence,
      localInstallation,
      managedRuntime,
      runtimeLayer: concreteRuntimeLayer as RuntimeControlPlaneLayer,
      close: async () => {
        await Effect.runPromise(clearAllMcpConnectionPools()).catch(() => undefined);
        await managedRuntime.dispose().catch(() => undefined);
      },
    };
  }).pipe(Effect.provide(NodeFileSystem.layer));
