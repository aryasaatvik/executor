/**
 * Control plane composition function.
 *
 * Accepts an ExecutorWorld (platform-specific port implementations) and
 * returns a composed control-plane runtime. This is the main entry point
 * for wiring up the executor control plane on any platform.
 *
 * During the migration period, this delegates to @executor/engine internals
 * for services that have not yet been fully moved to control-plane. Once all
 * services are migrated, the engine dependency will be removed.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ManagedRuntime from "effect/ManagedRuntime";

import type { ExecutorWorld } from "./world";
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
} from "./ports/index";

// ── Engine compat (transitional) ─────────────────────────────────────
// These imports will be removed once services are fully migrated.
import type { ResolveSecretMaterial } from "./services/engine/secret-material-store";

import {
  createEngineRuntime,
  createEngineApiLayer,
  type RuntimeEngineLayer,
  type RuntimeEngineOptions,
  type EngineRuntime,
  EngineApiLive,
  type EngineRuntimeContext,
} from "@executor/engine";

// ── Types ────────────────────────────────────────────────────────────

export type ControlPlaneOptions = {
  /**
   * Custom execution environment resolver.
   * If not provided, defaults to the engine's built-in resolver.
   */
  readonly executionResolver?: RuntimeEngineOptions["executionResolver"];

  /**
   * Custom secret material resolver.
   */
  readonly resolveSecretMaterial?: ResolveSecretMaterial;

  /**
   * Callback to get the local server base URL.
   * Used by auth flows that need to construct callback URLs.
   */
  readonly getLocalServerBaseUrl?: () => string | undefined;

  /**
   * Path to local data directory (SQLite databases, etc.).
   */
  readonly localDataDir?: string;

  /**
   * Root directory of the workspace.
   */
  readonly workspaceRoot?: string;

  /**
   * Path to home configuration.
   */
  readonly homeConfigPath?: string;

  /**
   * Path to home state directory.
   */
  readonly homeStateDirectory?: string;
};

export type ControlPlane = {
  /**
   * The underlying engine runtime.
   * Transitional — will be replaced by native control-plane runtime.
   */
  readonly engineRuntime: EngineRuntime;

  /**
   * The composed Effect layer providing all control-plane services.
   * Can be used with HttpApiBuilder, RpcServer, etc.
   */
  readonly runtimeLayer: RuntimeEngineLayer;

  /**
   * Managed runtime for running effects against the control plane.
   */
  readonly managedRuntime: ManagedRuntime.ManagedRuntime<EngineRuntimeContext, never>;

  /**
   * Create a fully-wired HTTP API layer (Effect HttpApiBuilder).
   * Provide this to HttpApiBuilder.toWebHandler to get a request handler.
   */
  readonly apiLayer: Layer.Layer<
    Layer.Layer.Success<typeof EngineApiLive>,
    Layer.Layer.Error<typeof EngineApiLive>,
    never
  >;

  /**
   * Shut down the control plane and release all resources.
   */
  readonly close: () => Promise<void>;
};

/**
 * Create a port layer from the world's port implementations.
 *
 * This converts the world's plain-object port implementations into
 * Effect Context.Tag layers so they can be consumed by services.
 */
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

/**
 * Create a control plane from an ExecutorWorld and options.
 *
 * This is the primary composition function. It wires the world's port
 * implementations into Effect layers and builds a complete runtime that
 * can serve HTTP API, MCP, and RPC requests.
 *
 * ## Transitional behavior
 *
 * Currently delegates to the engine's `createEngineRuntime()` for the
 * actual layer composition, since most services still live in the engine.
 * The world's ports are available as layers but not yet consumed by all
 * services. As services migrate to control-plane, they will consume ports
 * directly instead of engine internals.
 *
 * @example
 * ```ts
 * import { createControlPlane } from "@executor/control-plane";
 * import { createLocalWorld } from "@executor/worlds-local";
 *
 * const world = createLocalWorld({ ... });
 * const cp = await Effect.runPromise(createControlPlane(world, { workspaceRoot: "." }));
 *
 * // Use cp.apiLayer with HttpApiBuilder.toWebHandler for HTTP
 * // Use cp.engineRuntime with createExecutorMcpRequestHandler for MCP
 * // Use cp.close() to shut down
 * ```
 */
export const createControlPlane = (
  world: ExecutorWorld,
  options: ControlPlaneOptions = {},
): Effect.Effect<ControlPlane, Error> =>
  Effect.gen(function* () {
    // Build port layers from the world (available for future service use)
    const _portLayers = worldToPortLayers(world);

    // Run world lifecycle if available
    if (world.start) {
      yield* world.start().pipe(
        Effect.mapError(
          (cause) =>
            new Error(
              `Control plane world start failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            ),
        ),
      );
    }

    // Delegate to the engine's runtime creation (transitional)
    const engineRuntime = yield* createEngineRuntime({
      executionResolver: options.executionResolver,
      resolveSecretMaterial: options.resolveSecretMaterial,
      getLocalServerBaseUrl: options.getLocalServerBaseUrl,
      localDataDir: options.localDataDir,
      workspaceRoot: options.workspaceRoot,
      homeConfigPath: options.homeConfigPath,
      homeStateDirectory: options.homeStateDirectory,
    });

    const runtimeLayer = engineRuntime.runtimeLayer;

    // Build the HTTP API layer
    const apiLayer = createEngineApiLayer(runtimeLayer);

    return {
      engineRuntime,
      runtimeLayer,
      managedRuntime: engineRuntime.managedRuntime,
      apiLayer,
      close: async () => {
        // Close world lifecycle if available
        if (world.close) {
          await Effect.runPromise(world.close()).catch(() => undefined);
        }
        await engineRuntime.close();
      },
    } satisfies ControlPlane;
  });

export type { ExecutorWorld } from "./world";
