import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type {
  ExecutionEnvironment,
  ResolveExecutionEnvironment,
} from "../state";
import {
  createCodeExecutorForRuntime,
  resolveConfiguredExecutionRuntime,
} from "../runtime";
import { createWorkspaceToolInvoker } from "./tool-invoker";
import {
  acquireWorkspaceSourceCatalog,
  type ManagedWorkspaceSourceCatalog,
  indexWorkspaceToolsIntoSqlite,
} from "./source-catalog";
import {
  RuntimeSourceAuthServiceTag,
} from "../../sources/source-auth-service";
import {
  RuntimeSourceCatalogStoreService,
} from "../../catalog/source/runtime";
import { RuntimeSourceAuthMaterialService } from "../../auth/source-auth-material";
import {
  getRuntimeLocalWorkspaceOption,
  type RuntimeLocalWorkspaceState,
} from "../../local/runtime-context";
import {
  SecretMaterialResolverService,
  type ResolveSecretMaterial,
} from "../../local/secret-material-providers";
import {
  LocalToolRuntimeLoaderService,
  type LocalToolRuntimeLoaderShape,
} from "../../local/tools";
import {
  SourceArtifactStore,
  type SourceArtifactStoreShape,
  WorkspaceConfigStore,
  type WorkspaceConfigStoreShape,
  WorkspaceStateStore,
  type WorkspaceStateStoreShape,
} from "../../local/storage";
import { createEmbedder, type Embedder } from "../../../db/embedder";
import type { AccountId, LocalExecutorConfig, SecretRef, Source } from "#schema";
import type { LocalWorkspaceState } from "../../local/workspace-state";
export {
  createCodeExecutorForRuntime,
  resolveConfiguredExecutionRuntime,
} from "../runtime";

const semanticSearchEmbedderCache = new Map<
  string,
  Promise<Embedder | undefined>
>()

type WorkspaceCatalogCacheEntry = {
  indexSignature: string
  managedSourceCatalog: ManagedWorkspaceSourceCatalog
}

type SemanticSearchConfig = NonNullable<LocalExecutorConfig["semanticSearch"]>
type ResolvedSemanticSearchConfig = Omit<SemanticSearchConfig, "apiKeyRef"> & {
  apiKey?: string
}

type WorkspaceSourceCatalogManager = {
  getOrRefresh: (input: {
    workspaceId: Source["workspaceId"]
    accountId: AccountId
    runtimeLocalWorkspace: RuntimeLocalWorkspaceState
    workspaceState: LocalWorkspaceState
    sourceCatalogStore: Effect.Effect.Success<typeof RuntimeSourceCatalogStoreService>
    workspaceConfigStore: WorkspaceConfigStoreShape
    workspaceStateStore: WorkspaceStateStoreShape
    sourceArtifactStore: SourceArtifactStoreShape
    embedder?: Embedder
  }) => Effect.Effect<ManagedWorkspaceSourceCatalog, unknown, never>
  clear: Effect.Effect<void, never, never>
}

type WorkspaceEnvironmentDependencies = {
  createEmbedder?: typeof createEmbedder;
  loadConfiguredSemanticSearchEmbedder?: typeof loadConfiguredSemanticSearchEmbedder;
  getRuntimeLocalWorkspaceOption?: typeof getRuntimeLocalWorkspaceOption;
  workspaceSourceCatalogManager?: WorkspaceSourceCatalogManager;
  createWorkspaceToolInvoker?: typeof createWorkspaceToolInvoker;
}

export class WorkspaceSourceCatalogManagerService extends Context.Tag(
  "#runtime/WorkspaceSourceCatalogManagerService",
)<WorkspaceSourceCatalogManagerService, WorkspaceSourceCatalogManager>() {}

const semanticSearchEmbedderCacheKey = (
  config: ResolvedSemanticSearchConfig,
): string =>
  JSON.stringify({
    provider: config.provider,
    model: config.model ?? null,
    apiKeyHash: config.apiKey
      ? createHash("sha256").update(config.apiKey).digest("hex")
      : null,
    dimensions: config.dimensions ?? null,
  })

const resolveConfiguredSemanticSearchConfig = (
  resolveSecretMaterial: ResolveSecretMaterial,
  config: LocalExecutorConfig | null | undefined,
): Effect.Effect<ResolvedSemanticSearchConfig | undefined, unknown, never> => {
  const semanticSearchConfig = config?.semanticSearch
  if (!semanticSearchConfig) {
    return Effect.succeed(undefined)
  }

  if (semanticSearchConfig.provider === "local") {
    if (semanticSearchConfig.apiKeyRef !== undefined) {
      return Effect.fail(
        new Error('Local semantic search does not accept "apiKeyRef".'),
      )
    }

    return Effect.succeed({
      provider: semanticSearchConfig.provider,
      ...(semanticSearchConfig.model !== undefined
        ? { model: semanticSearchConfig.model }
        : {}),
      ...(semanticSearchConfig.dimensions !== undefined
        ? { dimensions: semanticSearchConfig.dimensions }
        : {}),
    })
  }

  if (
    semanticSearchConfig.provider !== "google" &&
    semanticSearchConfig.provider !== "openai"
  ) {
    return Effect.fail(
      new Error(
        `Semantic search provider "${semanticSearchConfig.provider}" is not supported.`,
      ),
    )
  }

  if (!semanticSearchConfig.apiKeyRef) {
    return Effect.fail(
      new Error(
        `Semantic search provider "${semanticSearchConfig.provider}" requires an apiKeyRef secret.`,
      ),
    )
  }

  return Effect.map(
    resolveSecretMaterial({ ref: semanticSearchConfig.apiKeyRef as SecretRef }),
    (apiKey) => ({
      provider: semanticSearchConfig.provider,
      ...(semanticSearchConfig.model !== undefined
        ? { model: semanticSearchConfig.model }
        : {}),
      ...(semanticSearchConfig.dimensions !== undefined
        ? { dimensions: semanticSearchConfig.dimensions }
        : {}),
      apiKey,
    }),
  )
}

const getCachedSemanticSearchEmbedder = (
  config: ResolvedSemanticSearchConfig,
  createEmbedderImpl: typeof createEmbedder,
): Promise<Embedder | undefined> => {
  const cacheKey = semanticSearchEmbedderCacheKey(config)
  const existing = semanticSearchEmbedderCache.get(cacheKey)
  if (existing) {
    return existing
  }

  const pending = createEmbedderImpl(config).then(async (embedder) => {
    if (!embedder) {
      return undefined
    }

    // Local embedders may only know their true output width after the first
    // embedding call. Remote AI SDK embedders already report concrete defaults.
    if (config.provider === "local" && config.dimensions == null) {
      await embedder.embed("__executor_dimension_probe__", "document")
    }

    return embedder
  })
  semanticSearchEmbedderCache.set(cacheKey, pending)
  return pending.catch((error) => {
    semanticSearchEmbedderCache.delete(cacheKey)
    throw error
  })
}

export const clearSemanticSearchEmbedderCacheForTests = (): void => {
  semanticSearchEmbedderCache.clear()
}

export const clearWorkspaceExecutionCachesForTests = (): void => {
  semanticSearchEmbedderCache.clear()
}

const workspaceCatalogCacheKey = (input: {
  stateDirectory: string
  workspaceId: string
  accountId: string
}): string =>
  JSON.stringify(input)

const workspaceCatalogIndexSignature = (input: {
  workspaceState: LocalWorkspaceState
  embedder?: Embedder
}): string =>
  JSON.stringify({
    semanticSearchSignature: input.workspaceState.catalog.semanticSearchSignature,
    embedder: input.embedder
      ? {
          provider: input.embedder.provider,
          model: input.embedder.model,
          dimensions: input.embedder.dimensions,
        }
      : null,
    sources: Object.entries(input.workspaceState.sources)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sourceId, state]) => ({
        sourceId,
        status: state.status,
        sourceHash: state.sourceHash,
        updatedAt: state.updatedAt,
      })),
  })

export const loadConfiguredSemanticSearchEmbedder = (
  resolveSecretMaterial: ResolveSecretMaterial,
  config: LocalExecutorConfig | null | undefined,
  options?: {
    createEmbedder?: typeof createEmbedder
  },
): Effect.Effect<Embedder | undefined, unknown, never> =>
  Effect.flatMap(
    resolveConfiguredSemanticSearchConfig(resolveSecretMaterial, config),
    (semanticSearchConfig) => {
      if (!semanticSearchConfig) {
        return Effect.succeed(undefined)
      }

      return Effect.tryPromise({
        try: () =>
          getCachedSemanticSearchEmbedder(
            semanticSearchConfig,
            options?.createEmbedder ?? createEmbedder,
          ),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      }).pipe(
        Effect.map((embedder) => embedder ?? undefined),
      )
    },
  )

const closeWorkspaceCatalogCache = (
  cache: Map<string, WorkspaceCatalogCacheEntry>,
): Effect.Effect<void, never, never> =>
  Effect.forEach(
    [...cache.values()],
    (entry) => entry.managedSourceCatalog.close,
    { discard: true },
  ).pipe(
    Effect.zipRight(Effect.sync(() => {
      cache.clear()
    })),
    Effect.ignore,
  )

const makeWorkspaceSourceCatalogManager = (dependencies: {
  indexWorkspaceToolsIntoSqlite?: typeof indexWorkspaceToolsIntoSqlite
  acquireWorkspaceSourceCatalog?: typeof acquireWorkspaceSourceCatalog
} = {}) =>
  Effect.gen(function* () {
    const cache = new Map<string, WorkspaceCatalogCacheEntry>()
    yield* Effect.addFinalizer(() => closeWorkspaceCatalogCache(cache))

    const indexWorkspaceToolsIntoSqliteImpl =
      dependencies.indexWorkspaceToolsIntoSqlite ?? indexWorkspaceToolsIntoSqlite
    const acquireWorkspaceSourceCatalogImpl =
      dependencies.acquireWorkspaceSourceCatalog ?? acquireWorkspaceSourceCatalog

    return {
      getOrRefresh: (input) =>
        Effect.gen(function* () {
          const cacheKey = workspaceCatalogCacheKey({
            stateDirectory: input.runtimeLocalWorkspace.context.stateDirectory,
            workspaceId: input.workspaceId,
            accountId: input.accountId,
          })
          const nextIndexSignature = workspaceCatalogIndexSignature({
            workspaceState: input.workspaceState,
            embedder: input.embedder,
          })
          const cached = cache.get(cacheKey)

          if (cached?.indexSignature === nextIndexSignature) {
            return cached.managedSourceCatalog
          }

          if (cached) {
            cache.delete(cacheKey)
            yield* cached.managedSourceCatalog.close
          }

          yield* indexWorkspaceToolsIntoSqliteImpl({
            workspaceId: input.workspaceId,
            accountId: input.accountId,
            sourceCatalogStore: input.sourceCatalogStore,
            workspaceConfigStore: input.workspaceConfigStore,
            workspaceStateStore: input.workspaceStateStore,
            sourceArtifactStore: input.sourceArtifactStore,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
            embedder: input.embedder,
          })

          const managedSourceCatalog = yield* acquireWorkspaceSourceCatalogImpl({
            workspaceId: input.workspaceId,
            accountId: input.accountId,
            sourceCatalogStore: input.sourceCatalogStore,
            workspaceConfigStore: input.workspaceConfigStore,
            workspaceStateStore: input.workspaceStateStore,
            sourceArtifactStore: input.sourceArtifactStore,
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
            embedder: input.embedder,
          })

          cache.set(cacheKey, {
            indexSignature: nextIndexSignature,
            managedSourceCatalog,
          })

          return managedSourceCatalog
        }),
      clear: closeWorkspaceCatalogCache(cache),
    } satisfies WorkspaceSourceCatalogManager
  })

export const createWorkspaceExecutionEnvironmentResolver = (input: {
  resolveSecretMaterial: ResolveSecretMaterial;
  sourceAuthMaterialService: Effect.Effect.Success<typeof RuntimeSourceAuthMaterialService>;
  sourceAuthService: Effect.Effect.Success<typeof RuntimeSourceAuthServiceTag>;
  sourceCatalogStore: Effect.Effect.Success<typeof RuntimeSourceCatalogStoreService>;
  localToolRuntimeLoader: LocalToolRuntimeLoaderShape;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  workspaceStateStore: WorkspaceStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
  dependencies?: WorkspaceEnvironmentDependencies;
}): ResolveExecutionEnvironment =>
  ({ workspaceId, accountId, onElicitation }) =>
    Effect.gen(function* () {
      const dependencies = {
        createEmbedder,
        loadConfiguredSemanticSearchEmbedder,
        getRuntimeLocalWorkspaceOption,
        createWorkspaceToolInvoker,
        ...input.dependencies,
      };
      const runtimeLocalWorkspace = yield* dependencies.getRuntimeLocalWorkspaceOption();
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
      const loadedWorkspaceState = yield* input.workspaceStateStore.load(
        runtimeLocalWorkspace.context,
      );
      const localToolRuntime = yield* input.localToolRuntimeLoader.load(
        runtimeLocalWorkspace.context,
      );
      const embedder = yield* dependencies.loadConfiguredSemanticSearchEmbedder(
        input.resolveSecretMaterial,
        loadedConfig?.config,
        {
          createEmbedder: dependencies.createEmbedder,
        },
      );
      if (!dependencies.workspaceSourceCatalogManager) {
        return yield* Effect.dieMessage(
          "WorkspaceSourceCatalogManager is required for local workspace resolution.",
        )
      }
      const managedSourceCatalog =
        yield* dependencies.workspaceSourceCatalogManager.getOrRefresh({
          workspaceId,
          accountId,
          runtimeLocalWorkspace,
          workspaceState: loadedWorkspaceState,
          sourceCatalogStore: input.sourceCatalogStore,
          workspaceConfigStore: input.workspaceConfigStore,
          workspaceStateStore: input.workspaceStateStore,
          sourceArtifactStore: input.sourceArtifactStore,
          embedder,
        })

      const sourceCatalog = managedSourceCatalog.catalog

      const { catalog, toolInvoker } = dependencies.createWorkspaceToolInvoker({
        workspaceId,
        accountId,
        sourceCatalogStore: input.sourceCatalogStore,
        sourceCatalog,
        workspaceConfigStore: input.workspaceConfigStore,
        workspaceStateStore: input.workspaceStateStore,
        sourceArtifactStore: input.sourceArtifactStore,
        sourceAuthMaterialService: input.sourceAuthMaterialService,
        sourceAuthService: input.sourceAuthService,
        runtimeLocalWorkspace,
        localToolRuntime,
        embedder,
        onElicitation,
      });

      const executor = createCodeExecutorForRuntime(
        resolveConfiguredExecutionRuntime(loadedConfig?.config),
      );

      return {
        executor,
        toolInvoker,
        catalog,
      } satisfies ExecutionEnvironment;
    });

export class RuntimeExecutionResolverService extends Context.Tag(
  "#runtime/RuntimeExecutionResolverService",
)<
  RuntimeExecutionResolverService,
  ReturnType<typeof createWorkspaceExecutionEnvironmentResolver>
>() {}

export const RuntimeExecutionResolverLive = (
  input: {
    executionResolver?: ResolveExecutionEnvironment;
  } = {},
) =>
  input.executionResolver
    ? Layer.succeed(RuntimeExecutionResolverService, input.executionResolver)
      : Layer.effect(
        RuntimeExecutionResolverService,
        Effect.gen(function* () {
          const resolveSecretMaterial = yield* SecretMaterialResolverService;
          const sourceAuthMaterialService = yield* RuntimeSourceAuthMaterialService;
          const sourceAuthService = yield* RuntimeSourceAuthServiceTag;
          const sourceCatalogStore = yield* RuntimeSourceCatalogStoreService;
          const localToolRuntimeLoader = yield* LocalToolRuntimeLoaderService;
          const workspaceConfigStore = yield* WorkspaceConfigStore;
          const workspaceStateStore = yield* WorkspaceStateStore;
          const sourceArtifactStore = yield* SourceArtifactStore;
          const workspaceSourceCatalogManager =
            yield* WorkspaceSourceCatalogManagerService;

          return createWorkspaceExecutionEnvironmentResolver({
            resolveSecretMaterial,
            sourceAuthService,
            sourceAuthMaterialService,
            sourceCatalogStore,
            localToolRuntimeLoader,
            workspaceConfigStore,
            workspaceStateStore,
            sourceArtifactStore,
            dependencies: {
              workspaceSourceCatalogManager,
            },
          });
        }),
      ).pipe(
        Layer.provideMerge(
          Layer.scoped(
            WorkspaceSourceCatalogManagerService,
            makeWorkspaceSourceCatalogManager(),
          ),
        ),
      );
