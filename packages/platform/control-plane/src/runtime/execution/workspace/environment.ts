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
import { indexWorkspaceToolsIntoSqlite } from "./source-catalog";
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

    // Prime local embedders once so the actual output dimensions are known
    // before SQLite provisions the vec table shape.
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
      const localToolRuntime =
        runtimeLocalWorkspace === null
          ? createEmptyLocalToolRuntime()
          : yield* input.localToolRuntimeLoader.load(runtimeLocalWorkspace.context);
      const embedder = yield* loadConfiguredSemanticSearchEmbedder(
        loadedConfig?.config,
      );
      const sqliteCatalogReady =
        runtimeLocalWorkspace === null
          ? false
          : yield* indexWorkspaceToolsIntoSqlite({
            workspaceId,
            accountId,
            sourceCatalogStore: input.sourceCatalogStore,
            workspaceConfigStore: input.workspaceConfigStore,
            workspaceStateStore: input.workspaceStateStore,
            sourceArtifactStore: input.sourceArtifactStore,
            runtimeLocalWorkspace,
            embedder,
          });

      const { catalog, toolInvoker } = createWorkspaceToolInvoker({
        workspaceId,
        accountId,
        sourceCatalogStore: input.sourceCatalogStore,
        workspaceConfigStore: input.workspaceConfigStore,
        workspaceStateStore: input.workspaceStateStore,
        sourceArtifactStore: input.sourceArtifactStore,
        sourceAuthMaterialService: input.sourceAuthMaterialService,
        sourceAuthService: input.sourceAuthService,
        runtimeLocalWorkspace,
        localToolRuntime,
        embedder,
        sqliteCatalogReady,
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
