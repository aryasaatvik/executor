import {
  createToolCatalogFromTools,
  makeToolInvokerFromTools,
} from "@executor/codemode-core";
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
  createWorkspaceSourceCatalog,
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
} from "../../local/runtime-context";
import {
  LocalToolRuntimeLoaderService,
  type LocalToolRuntimeLoaderShape,
  type LocalToolRuntime,
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
import type { LocalExecutorConfig } from "#schema";
import type { LocalWorkspaceState } from "../../local/workspace-state";
export {
  createCodeExecutorForRuntime,
  resolveConfiguredExecutionRuntime,
} from "../runtime";

const createEmptyLocalToolRuntime = (): LocalToolRuntime => ({
  tools: {},
  catalog: createToolCatalogFromTools({ tools: {} }),
  toolInvoker: makeToolInvokerFromTools({ tools: {} }),
  toolPaths: new Set<string>(),
});

const semanticSearchEmbedderCache = new Map<
  string,
  Promise<Embedder | undefined>
>()

type WorkspaceCatalogCacheEntry = {
  indexSignature: string
  sourceCatalog: ReturnType<typeof createWorkspaceSourceCatalog>
}

const workspaceCatalogCache = new Map<string, WorkspaceCatalogCacheEntry>()

type SemanticSearchConfig = NonNullable<LocalExecutorConfig["semanticSearch"]>

const semanticSearchEmbedderCacheKey = (
  config: SemanticSearchConfig,
): string =>
  JSON.stringify({
    provider: config.provider,
    model: config.model ?? null,
    apiKey: config.apiKey ?? null,
    dimensions: config.dimensions ?? null,
  })

const getCachedSemanticSearchEmbedder = (
  config: SemanticSearchConfig,
): Promise<Embedder | undefined> => {
  const cacheKey = semanticSearchEmbedderCacheKey(config)
  const existing = semanticSearchEmbedderCache.get(cacheKey)
  if (existing) {
    return existing
  }

  const pending = createEmbedder(config).then(async (embedder) => {
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
  workspaceCatalogCache.clear()
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
    semanticSearchSignature: input.workspaceState.catalog?.semanticSearchSignature ?? null,
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
  config: LocalExecutorConfig | null | undefined,
): Effect.Effect<Embedder | undefined, never, never> => {
  const semanticSearchConfig = config?.semanticSearch;
  if (!semanticSearchConfig) {
    return Effect.succeed(undefined);
  }

  return Effect.tryPromise(() => getCachedSemanticSearchEmbedder(semanticSearchConfig)).pipe(
    Effect.map((embedder) => embedder ?? undefined),
    Effect.catchAll((error) =>
      Effect.logWarning(
        `Failed to initialize semantic search embedder: ${error instanceof Error ? error.message : String(error)}`,
      ).pipe(Effect.as(undefined)),
    ),
  );
};

export const createWorkspaceExecutionEnvironmentResolver = (input: {
  sourceAuthMaterialService: Effect.Effect.Success<typeof RuntimeSourceAuthMaterialService>;
  sourceAuthService: Effect.Effect.Success<typeof RuntimeSourceAuthServiceTag>;
  sourceCatalogStore: Effect.Effect.Success<typeof RuntimeSourceCatalogStoreService>;
  localToolRuntimeLoader: LocalToolRuntimeLoaderShape;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  workspaceStateStore: WorkspaceStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
}): ResolveExecutionEnvironment =>
  ({ workspaceId, accountId, onElicitation }) =>
    Effect.gen(function* () {
      const runtimeLocalWorkspace = yield* getRuntimeLocalWorkspaceOption();
      const loadedConfig =
        runtimeLocalWorkspace === null
          ? null
          : yield* input.workspaceConfigStore.load(runtimeLocalWorkspace.context);
      const loadedWorkspaceState =
        runtimeLocalWorkspace === null
          ? null
          : yield* input.workspaceStateStore.load(runtimeLocalWorkspace.context);
      const localToolRuntime =
        runtimeLocalWorkspace === null
          ? createEmptyLocalToolRuntime()
          : yield* input.localToolRuntimeLoader.load(runtimeLocalWorkspace.context);
      const embedder = yield* loadConfiguredSemanticSearchEmbedder(
        loadedConfig?.config,
      );
      const cachedWorkspaceCatalog =
        runtimeLocalWorkspace === null || loadedWorkspaceState === null
          ? undefined
          : workspaceCatalogCache.get(
              workspaceCatalogCacheKey({
                stateDirectory: runtimeLocalWorkspace.context.stateDirectory,
                workspaceId,
                accountId,
              }),
            );
      const nextWorkspaceCatalogSignature =
        runtimeLocalWorkspace === null || loadedWorkspaceState === null
          ? null
          : workspaceCatalogIndexSignature({
              workspaceState: loadedWorkspaceState,
              embedder,
            });
      const canReuseCachedSqliteCatalog =
        cachedWorkspaceCatalog?.indexSignature === nextWorkspaceCatalogSignature;
      if (runtimeLocalWorkspace !== null && !canReuseCachedSqliteCatalog) {
        yield* indexWorkspaceToolsIntoSqlite({
          workspaceId,
          accountId,
          sourceCatalogStore: input.sourceCatalogStore,
          workspaceConfigStore: input.workspaceConfigStore,
          workspaceStateStore: input.workspaceStateStore,
          sourceArtifactStore: input.sourceArtifactStore,
          runtimeLocalWorkspace,
          embedder,
        });
      }
      const sourceCatalog =
        runtimeLocalWorkspace === null
          ? createWorkspaceSourceCatalog({
              workspaceId,
              accountId,
              sourceCatalogStore: input.sourceCatalogStore,
              workspaceConfigStore: input.workspaceConfigStore,
              workspaceStateStore: input.workspaceStateStore,
              sourceArtifactStore: input.sourceArtifactStore,
              runtimeLocalWorkspace,
              embedder,
            })
          : canReuseCachedSqliteCatalog
            ? cachedWorkspaceCatalog.sourceCatalog
            : createWorkspaceSourceCatalog({
                workspaceId,
                accountId,
                sourceCatalogStore: input.sourceCatalogStore,
                workspaceConfigStore: input.workspaceConfigStore,
                workspaceStateStore: input.workspaceStateStore,
                sourceArtifactStore: input.sourceArtifactStore,
                runtimeLocalWorkspace,
                embedder,
              });

      if (
        runtimeLocalWorkspace !== null &&
        nextWorkspaceCatalogSignature !== null
      ) {
        workspaceCatalogCache.set(
          workspaceCatalogCacheKey({
            stateDirectory: runtimeLocalWorkspace.context.stateDirectory,
            workspaceId,
            accountId,
          }),
          {
            indexSignature: nextWorkspaceCatalogSignature,
            sourceCatalog,
          },
        );
      } else if (runtimeLocalWorkspace !== null) {
        workspaceCatalogCache.delete(
          workspaceCatalogCacheKey({
            stateDirectory: runtimeLocalWorkspace.context.stateDirectory,
            workspaceId,
            accountId,
          }),
        );
      }

      const { catalog, toolInvoker } = createWorkspaceToolInvoker({
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
          const sourceAuthMaterialService = yield* RuntimeSourceAuthMaterialService;
          const sourceAuthService = yield* RuntimeSourceAuthServiceTag;
          const sourceCatalogStore = yield* RuntimeSourceCatalogStoreService;
          const localToolRuntimeLoader = yield* LocalToolRuntimeLoaderService;
          const workspaceConfigStore = yield* WorkspaceConfigStore;
          const workspaceStateStore = yield* WorkspaceStateStore;
          const sourceArtifactStore = yield* SourceArtifactStore;

          return createWorkspaceExecutionEnvironmentResolver({
            sourceAuthService,
            sourceAuthMaterialService,
            sourceCatalogStore,
            localToolRuntimeLoader,
            workspaceConfigStore,
            workspaceStateStore,
            sourceArtifactStore,
          });
        }),
      );
