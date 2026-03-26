// TODO: This file has extensive engine-internal dependencies.
// Most imports reference engine runtime services that should eventually
// be replaced with control-plane port interfaces and world implementations.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type {
  ExecutionEnvironment,
  ResolveExecutionEnvironment,
} from "./execution-state";
import {
  createCodeExecutorForRuntime,
  resolveConfiguredExecutionRuntime,
} from "./runtime";
import {
  createWorkspaceToolInvoker,
  type RuntimeLocalWorkspaceState,
  type LocalToolRuntime,
} from "./tool-invoker";
import {
  acquireWorkspaceSourceCatalog,
  indexWorkspaceToolsIntoSqlite,
  type ManagedWorkspaceSourceCatalog,
} from "./source-catalog";
import type { AccountId, Source } from "../../model/index";

// Re-export for consumers
export {
  type ResolveExecutionEnvironment,
} from "./execution-state";

// TODO: These engine-internal types should be replaced with control-plane
// port interfaces. For now, define minimal placeholder types.

/** Placeholder — engine's Embedder */
type Embedder = {
  dimensions: number;
  [key: string]: unknown;
};

/** Placeholder — engine's SourceCatalogStore shape */
type SourceCatalogStoreShape = {
  loadWorkspaceSourceCatalogToolIndex: (input: {
    workspaceId: Source["workspaceId"];
    actorAccountId: AccountId;
    includeSchemas: boolean;
  }) => Effect.Effect<readonly unknown[], Error>;
  loadWorkspaceSourceCatalogToolByPath: (input: {
    workspaceId: Source["workspaceId"];
    path: string;
    actorAccountId: AccountId;
    includeSchemas: boolean;
  }) => Effect.Effect<unknown, Error>;
};

/** Placeholder — engine's SourceStore shape */
type SourceStoreShape = {
  loadSourceById: (input: {
    workspaceId: Source["workspaceId"];
    sourceId: Source["id"];
    actorAccountId: AccountId;
  }) => Effect.Effect<Source, Error>;
};

/** Placeholder — engine's WorkspaceConfigStoreShape */
type WorkspaceConfigStoreShape = {
  load: (context: unknown) => Effect.Effect<{ config?: unknown } | null>;
};

/** Placeholder — engine's SourceAuthMaterial shape */
type SourceAuthMaterialShape = {
  resolve: (input: {
    source: unknown;
    actorAccountId: AccountId;
    context?: unknown;
  }) => Effect.Effect<unknown, unknown>;
};

/** Placeholder — engine's SourceAuthService shape */
type SourceAuthServiceShape = unknown;

/** Placeholder — engine's ResolveSecretMaterial */
type ResolveSecretMaterial = unknown;

/** Placeholder — engine's LocalToolRuntimeLoaderShape */
type LocalToolRuntimeLoaderShape = {
  load: (context: unknown) => Effect.Effect<LocalToolRuntime>;
};

type WorkspaceCatalogCacheEntry = {
  indexSignature: string;
  managedSourceCatalog: ManagedWorkspaceSourceCatalog;
};

type WorkspaceSourceCatalogManager = {
  getOrRefresh: (input: {
    workspaceId: Source["workspaceId"];
    accountId: AccountId;
    runtimeLocalWorkspace: NonNullable<RuntimeLocalWorkspaceState>;
    sourceCatalogStore: SourceCatalogStoreShape;
    workspaceConfigStore: WorkspaceConfigStoreShape;
    embedder?: Embedder;
  }) => Effect.Effect<ManagedWorkspaceSourceCatalog, unknown, never>;
  clear: Effect.Effect<void, never, never>;
};

type WorkspaceEnvironmentDependencies = {
  loadConfiguredSemanticSearchEmbedder?: (
    resolveSecretMaterial: ResolveSecretMaterial,
    config: unknown,
  ) => Effect.Effect<Embedder | undefined>;
  getRuntimeLocalWorkspaceOption?: () => Effect.Effect<RuntimeLocalWorkspaceState>;
  workspaceSourceCatalogManager?: WorkspaceSourceCatalogManager;
  createWorkspaceToolInvoker?: typeof createWorkspaceToolInvoker;
};

export const clearSemanticSearchEmbedderCacheForTests = (): void => {
  // TODO: Delegate to engine's cache clear during migration
};

export const clearWorkspaceExecutionCachesForTests = (): void => {
  // TODO: Delegate to engine's cache clear during migration
};

const closeWorkspaceCatalogCache = (
  cache: Map<string, WorkspaceCatalogCacheEntry>,
): Effect.Effect<void, never, never> =>
  Effect.forEach(
    [...cache.values()],
    (entry) => entry.managedSourceCatalog.close,
    { discard: true },
  ).pipe(
    Effect.zipRight(Effect.sync(() => {
      cache.clear();
    })),
    Effect.ignore,
  );

export const makeWorkspaceSourceCatalogManager = (dependencies: {
  indexWorkspaceToolsIntoSqlite?: typeof indexWorkspaceToolsIntoSqlite;
  acquireWorkspaceSourceCatalog?: typeof acquireWorkspaceSourceCatalog;
} = {}) =>
  Effect.gen(function* () {
    const cache = new Map<string, WorkspaceCatalogCacheEntry>();
    yield* Effect.addFinalizer(() => closeWorkspaceCatalogCache(cache));

    const indexWorkspaceToolsIntoSqliteImpl =
      dependencies.indexWorkspaceToolsIntoSqlite ?? indexWorkspaceToolsIntoSqlite;
    const acquireWorkspaceSourceCatalogImpl =
      dependencies.acquireWorkspaceSourceCatalog ?? acquireWorkspaceSourceCatalog;

    return {
      getOrRefresh: (input) =>
        Effect.gen(function* () {
          const cacheKey = `${input.runtimeLocalWorkspace.context.stateDirectory}:${input.workspaceId}:${input.accountId}`;
          const nextIndexSignature = input.embedder
            ? `embedder:${String(input.embedder.dimensions)}`
            : "no-embedder";
          const cached = cache.get(cacheKey);

          if (cached !== undefined && cached.indexSignature === nextIndexSignature) {
            return cached.managedSourceCatalog;
          }

          if (cached) {
            cache.delete(cacheKey);
            yield* cached.managedSourceCatalog.close;
          }

          yield* indexWorkspaceToolsIntoSqliteImpl({
            workspaceId: input.workspaceId,
            accountId: input.accountId,
            sourceCatalogStore: input.sourceCatalogStore as Parameters<typeof indexWorkspaceToolsIntoSqlite>[0]["sourceCatalogStore"],
            workspaceConfigStore: input.workspaceConfigStore,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
            embedder: input.embedder,
          });

          const managedSourceCatalog = yield* acquireWorkspaceSourceCatalogImpl({
            workspaceId: input.workspaceId,
            accountId: input.accountId,
            sourceCatalogStore: input.sourceCatalogStore as Parameters<typeof acquireWorkspaceSourceCatalog>[0]["sourceCatalogStore"],
            workspaceConfigStore: input.workspaceConfigStore,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
            embedder: input.embedder,
          });

          cache.set(cacheKey, {
            indexSignature: nextIndexSignature,
            managedSourceCatalog,
          });

          return managedSourceCatalog;
        }),
      clear: closeWorkspaceCatalogCache(cache),
    } satisfies WorkspaceSourceCatalogManager;
  });

export const createWorkspaceExecutionEnvironmentResolver = (input: {
  resolveSecretMaterial: ResolveSecretMaterial;
  sourceAuthMaterialService: SourceAuthMaterialShape;
  sourceAuthService: SourceAuthServiceShape;
  sourceCatalogStore: SourceCatalogStoreShape;
  sourceStore: SourceStoreShape;
  localToolRuntimeLoader: LocalToolRuntimeLoaderShape;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  dependencies?: WorkspaceEnvironmentDependencies;
}): ResolveExecutionEnvironment =>
  ({ workspaceId, accountId, onElicitation }) =>
    Effect.gen(function* () {
      const dependencies = {
        createWorkspaceToolInvoker,
        ...input.dependencies,
      };

      const getRuntimeLocalWorkspaceOption =
        dependencies.getRuntimeLocalWorkspaceOption
        ?? (() => Effect.succeed(null as RuntimeLocalWorkspaceState));

      const runtimeLocalWorkspace = yield* getRuntimeLocalWorkspaceOption();
      if (runtimeLocalWorkspace === null) {
        return yield* Effect.fail(
          new Error(
            "Runtime local workspace is required for execution environment resolution.",
          ),
        );
      }

      const loadedConfig = yield* input.workspaceConfigStore.load(
        runtimeLocalWorkspace.context,
      );
      const localToolRuntime = yield* input.localToolRuntimeLoader.load(
        runtimeLocalWorkspace.context,
      );

      // TODO: Semantic search embedder loading depends on engine internals.
      // For now, skip embedder resolution.
      const embedder: Embedder | undefined = undefined;

      if (!dependencies.workspaceSourceCatalogManager) {
        return yield* Effect.dieMessage(
          "WorkspaceSourceCatalogManager is required for local workspace resolution.",
        );
      }

      // TODO: resolveWorkspaceExecutionEnvironment is an engine program.
      // The logic should be inlined or migrated to control-plane.
      // For now, provide a simplified version.

      const managedCatalog = yield* dependencies.workspaceSourceCatalogManager.getOrRefresh({
        workspaceId,
        accountId,
        runtimeLocalWorkspace,
        sourceCatalogStore: input.sourceCatalogStore,
        workspaceConfigStore: input.workspaceConfigStore,
        embedder,
      });

      const { catalog, toolInvoker } = dependencies.createWorkspaceToolInvoker!({
        workspaceId,
        accountId,
        sourceCatalogStore: input.sourceCatalogStore as Parameters<typeof createWorkspaceToolInvoker>[0]["sourceCatalogStore"],
        sourceStore: input.sourceStore as Parameters<typeof createWorkspaceToolInvoker>[0]["sourceStore"],
        sourceCatalog: managedCatalog.catalog,
        workspaceConfigStore: input.workspaceConfigStore,
        sourceAuthMaterialService: input.sourceAuthMaterialService,
        sourceAuthService: input.sourceAuthService,
        runtimeLocalWorkspace,
        localToolRuntime,
        embedder,
        onElicitation,
      });

      const runtimeKind = resolveConfiguredExecutionRuntime(
        (loadedConfig as { config?: { runtime?: string } } | null)?.config as Parameters<typeof resolveConfiguredExecutionRuntime>[0],
      );
      const executor = createCodeExecutorForRuntime(runtimeKind);

      return {
        executor,
        toolInvoker,
        catalog,
      } satisfies ExecutionEnvironment;
    });

export class ExecutionEnvironmentResolver extends Context.Tag(
  "#runtime/ExecutionEnvironmentResolver",
)<
  ExecutionEnvironmentResolver,
  ReturnType<typeof createWorkspaceExecutionEnvironmentResolver>
>() {}

export const RuntimeExecutionResolverLive = (
  input: {
    executionResolver?: ResolveExecutionEnvironment;
  } = {},
) =>
  input.executionResolver
    ? Layer.succeed(ExecutionEnvironmentResolver, input.executionResolver)
    : Layer.fail(
        new Error(
          "ExecutionEnvironmentResolver requires explicit resolver during control-plane migration. " +
          "Use the engine's RuntimeExecutionResolverLive until services are fully migrated.",
        ),
      );
