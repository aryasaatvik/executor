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
  clearSemanticSearchEmbedderCacheForTests as clearSemanticSearchEmbedderCache,
  loadConfiguredSemanticSearchEmbedder,
  workspaceCatalogCacheKey,
  workspaceCatalogIndexSignature,
} from "../../programs/execution/semantic-search";
import {
  resolveWorkspaceExecutionEnvironment,
} from "../../programs/execution/workspace-environment";
import {
  SourceAuthService,
} from "../../sources/source-auth-service";
import {
  SourceStore,
} from "../../sources/source-store";
import {
  SourceCatalogStore,
} from "../../catalog/source/runtime";
import { SourceAuthMaterial } from "../../auth/source-auth-material";
import {
  getRuntimeLocalWorkspaceOption,
  type RuntimeLocalWorkspaceState,
} from "../../local/runtime-context";
import {
  SecretMaterialStore,
  type ResolveSecretMaterial,
} from "../../local/secret-material-providers";
import {
  LocalToolRuntimeLoader,
  type LocalToolRuntimeLoaderShape,
} from "../../local/tools";
import {
  WorkspaceConfigStore,
  type WorkspaceConfigStoreShape,
} from "../../local/storage";
import type { AccountId, Source } from "#schema";
import type { Embedder } from "../../../db/embedder";
export {
  createCodeExecutorForRuntime,
  resolveConfiguredExecutionRuntime,
} from "../runtime";
export { loadConfiguredSemanticSearchEmbedder } from "../../programs/execution/semantic-search";

type WorkspaceCatalogCacheEntry = {
  indexSignature: string
  managedSourceCatalog: ManagedWorkspaceSourceCatalog
}

type WorkspaceSourceCatalogManager = {
  getOrRefresh: (input: {
    workspaceId: Source["workspaceId"]
    accountId: AccountId
    runtimeLocalWorkspace: RuntimeLocalWorkspaceState
    sourceCatalogStore: Effect.Effect.Success<typeof SourceCatalogStore>
    workspaceConfigStore: WorkspaceConfigStoreShape
    embedder?: Embedder
  }) => Effect.Effect<ManagedWorkspaceSourceCatalog, unknown, never>
  clear: Effect.Effect<void, never, never>
}

type WorkspaceEnvironmentDependencies = {
  loadConfiguredSemanticSearchEmbedder?: typeof loadConfiguredSemanticSearchEmbedder;
  getRuntimeLocalWorkspaceOption?: typeof getRuntimeLocalWorkspaceOption;
  workspaceSourceCatalogManager?: WorkspaceSourceCatalogManager;
  createWorkspaceToolInvoker?: typeof createWorkspaceToolInvoker;
}

export const clearSemanticSearchEmbedderCacheForTests = (): void => {
  clearSemanticSearchEmbedderCache()
}

export const clearWorkspaceExecutionCachesForTests = (): void => {
  clearSemanticSearchEmbedderCache()
}

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

export const makeWorkspaceSourceCatalogManager = (dependencies: {
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
            embedder: input.embedder,
          })
          const cached = cache.get(cacheKey)

          if (cached !== undefined && cached.indexSignature === nextIndexSignature) {
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
            runtimeLocalWorkspace: input.runtimeLocalWorkspace,
            embedder: input.embedder,
          })

          const managedSourceCatalog = yield* acquireWorkspaceSourceCatalogImpl({
            workspaceId: input.workspaceId,
            accountId: input.accountId,
            sourceCatalogStore: input.sourceCatalogStore,
            workspaceConfigStore: input.workspaceConfigStore,
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
  sourceAuthMaterialService: Effect.Effect.Success<typeof SourceAuthMaterial>;
  sourceAuthService: Effect.Effect.Success<typeof SourceAuthService>;
  sourceCatalogStore: Effect.Effect.Success<typeof SourceCatalogStore>;
  sourceStore: Effect.Effect.Success<typeof SourceStore>;
  localToolRuntimeLoader: LocalToolRuntimeLoaderShape;
  workspaceConfigStore: WorkspaceConfigStoreShape;
  dependencies?: WorkspaceEnvironmentDependencies;
}): ResolveExecutionEnvironment =>
  ({ workspaceId, accountId, onElicitation }) =>
    Effect.gen(function* () {
      const dependencies = {
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
      const localToolRuntime = yield* input.localToolRuntimeLoader.load(
        runtimeLocalWorkspace.context,
      );
      const embedder = yield* dependencies.loadConfiguredSemanticSearchEmbedder(
        input.resolveSecretMaterial,
        loadedConfig?.config,
      );
      if (!dependencies.workspaceSourceCatalogManager) {
        return yield* Effect.dieMessage(
          "WorkspaceSourceCatalogManager is required for local workspace resolution.",
        )
      }
      return yield* resolveWorkspaceExecutionEnvironment({
        workspaceId,
        accountId,
        onElicitation,
        runtimeLocalWorkspace,
        loadedConfig: loadedConfig?.config,
        localToolRuntime,
        embedder,
        workspaceSourceCatalogManager: dependencies.workspaceSourceCatalogManager,
        sourceCatalogStore: input.sourceCatalogStore,
        sourceStore: input.sourceStore,
        workspaceConfigStore: input.workspaceConfigStore,
        sourceAuthMaterialService: input.sourceAuthMaterialService,
        sourceAuthService: input.sourceAuthService,
        resolveSecretMaterial: input.resolveSecretMaterial,
        loadConfiguredSemanticSearchEmbedder: dependencies.loadConfiguredSemanticSearchEmbedder,
        createWorkspaceToolInvoker: dependencies.createWorkspaceToolInvoker,
      });
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
      : Layer.effect(
        ExecutionEnvironmentResolver,
        Effect.gen(function* () {
          const secretMaterialStore = yield* SecretMaterialStore;
          const sourceAuthMaterialService = yield* SourceAuthMaterial;
          const sourceAuthService = yield* SourceAuthService;
          const sourceCatalogStore = yield* SourceCatalogStore;
          const sourceStore = yield* SourceStore;
          const localToolRuntimeLoader = yield* LocalToolRuntimeLoader;
          const workspaceConfigStore = yield* WorkspaceConfigStore;
          const workspaceSourceCatalogManager =
            yield* makeWorkspaceSourceCatalogManager();

          return createWorkspaceExecutionEnvironmentResolver({
            resolveSecretMaterial: secretMaterialStore.resolve,
            sourceAuthService,
            sourceAuthMaterialService,
            sourceCatalogStore,
            sourceStore,
            localToolRuntimeLoader,
            workspaceConfigStore,
            dependencies: {
              workspaceSourceCatalogManager,
            },
          });
        }),
      );
