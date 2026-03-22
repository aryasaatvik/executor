import {
  createToolCatalogFromTools,
  makeToolInvokerFromTools,
} from "@executor/codemode-core";
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
  SecretMaterialResolverService,
  type ResolveSecretMaterial,
} from "../../local/secret-material-providers";
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
import type { LocalExecutorConfig, SecretRef } from "#schema";
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
type ResolvedSemanticSearchConfig = Omit<SemanticSearchConfig, "apiKeyRef"> & {
  apiKey?: string
}

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
  resolveSecretMaterial: ResolveSecretMaterial,
  config: LocalExecutorConfig | null | undefined,
): Effect.Effect<Embedder | undefined, unknown, never> =>
  Effect.flatMap(
    resolveConfiguredSemanticSearchConfig(resolveSecretMaterial, config),
    (semanticSearchConfig) => {
      if (!semanticSearchConfig) {
        return Effect.succeed(undefined)
      }

      return Effect.tryPromise({
        try: () => getCachedSemanticSearchEmbedder(semanticSearchConfig),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      }).pipe(
        Effect.map((embedder) => embedder ?? undefined),
      )
    },
  )

export const createWorkspaceExecutionEnvironmentResolver = (input: {
  resolveSecretMaterial: ResolveSecretMaterial;
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
        input.resolveSecretMaterial,
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
          const resolveSecretMaterial = yield* SecretMaterialResolverService;
          const sourceAuthMaterialService = yield* RuntimeSourceAuthMaterialService;
          const sourceAuthService = yield* RuntimeSourceAuthServiceTag;
          const sourceCatalogStore = yield* RuntimeSourceCatalogStoreService;
          const localToolRuntimeLoader = yield* LocalToolRuntimeLoaderService;
          const workspaceConfigStore = yield* WorkspaceConfigStore;
          const workspaceStateStore = yield* WorkspaceStateStore;
          const sourceArtifactStore = yield* SourceArtifactStore;

          return createWorkspaceExecutionEnvironmentResolver({
            resolveSecretMaterial,
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
