import { join } from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type {
  SearchProviderInfo,
  SearchResult,
  Source,
} from "#schema";

import {
  RuntimeLocalScopeService,
} from "../scope/runtime-context";
import {
  ExecutorPluginRegistryService,
} from "../sources/source-plugins";
import {
  RuntimeSourceCatalogStoreService,
} from "../catalog/source/runtime";
import {
  expandCatalogTools,
} from "../catalog/source/runtime";
import {
  searchDocumentFromLoadedTool,
} from "./documents";
import {
  createLexicalSearchProvider,
  markSearchResultFallback,
} from "./lexical-provider";
import type {
  ExecutorSearchProvider,
  SearchProviderStatus,
  SearchProviderSyncPayload,
  SearchSourceRequest,
  SearchWorkspaceRequest,
  SearchProviderStorage,
} from "./types";

const DEFAULT_PROVIDER_KEY = "lexical";

const stateDirectoryFromRuntimeLocalScope = (
  runtimeLocalScope: Effect.Effect.Success<typeof RuntimeLocalScopeService>,
): string | null => {
  const value = runtimeLocalScope.scope.metadata?.stateDirectory;
  return typeof value === "string" && value.length > 0 ? value : null;
};

const providerStorage = (input: {
  runtimeLocalScope: Effect.Effect.Success<typeof RuntimeLocalScopeService>;
  providerKey: string;
}): SearchProviderStorage => {
  const stateDirectory = stateDirectoryFromRuntimeLocalScope(input.runtimeLocalScope);
  const rootDirectory =
    stateDirectory === null ? null : join(stateDirectory, "search", input.providerKey);

  return {
    rootDirectory,
    resolvePath: (name) => (rootDirectory === null ? null : join(rootDirectory, name)),
    resolveSqlitePath: (name) =>
      rootDirectory === null ? null : join(rootDirectory, `${name}.sqlite`),
  };
};

const providerInfoFromStatus = (
  status: SearchProviderStatus,
  fallbackUsed = false,
): SearchProviderInfo => ({
  providerKey: status.providerKey,
  mode: status.mode,
  backend: status.backend,
  ...(fallbackUsed ? { fallbackUsed: true } : {}),
});

type RuntimeSearchManagerShape = {
  searchWorkspace: (
    input: SearchWorkspaceRequest,
  ) => Effect.Effect<SearchResult, Error, never>;
  discoverSource: (
    input: SearchSourceRequest,
  ) => Effect.Effect<SearchResult, Error, never>;
  syncSourceCatalog: (input: SearchProviderSyncPayload) => Effect.Effect<void, Error, never>;
  removeSource: (input: {
    sourceId: Source["id"];
    reason: "removed" | "disabled" | "not_connected";
  }) => Effect.Effect<void, Error, never>;
  status: () => Effect.Effect<SearchProviderStatus, Error, never>;
  refresh: () => Effect.Effect<SearchProviderStatus, Error, never>;
  rebuild: () => Effect.Effect<SearchProviderStatus, Error, never>;
};

export class RuntimeSearchManagerService extends Context.Tag(
  "#runtime/RuntimeSearchManagerService",
)<RuntimeSearchManagerService, RuntimeSearchManagerShape>() {}

type CreateRuntimeSearchManagerInput = {
  runtimeLocalScope: Effect.Effect.Success<typeof RuntimeLocalScopeService>;
  pluginRegistry: Effect.Effect.Success<typeof ExecutorPluginRegistryService>;
  sourceCatalogStore: Effect.Effect.Success<typeof RuntimeSourceCatalogStoreService>;
};

const resolveConfiguredProvider = (input: CreateRuntimeSearchManagerInput): {
  configuredProviderKey: string;
  activeProvider: ExecutorSearchProvider;
  lexicalProvider: ExecutorSearchProvider;
} => {
  const lexicalProvider = createLexicalSearchProvider();
  const configuredProviderKey =
    input.runtimeLocalScope.loadedConfig.config?.search?.provider ?? DEFAULT_PROVIDER_KEY;

  if (configuredProviderKey === DEFAULT_PROVIDER_KEY) {
    return {
      configuredProviderKey,
      activeProvider: lexicalProvider,
      lexicalProvider,
    };
  }

  const contribution = input.pluginRegistry.getSearchProvider(configuredProviderKey);
  const decodeConfig = Schema.decodeUnknownSync(contribution.configSchema);
  const decodedConfig = decodeConfig(
    input.runtimeLocalScope.loadedConfig.config?.search?.config ?? {},
  );

  return {
    configuredProviderKey,
    activeProvider: contribution.create({
      config: decodedConfig,
      storage: providerStorage({
        runtimeLocalScope: input.runtimeLocalScope,
        providerKey: configuredProviderKey,
      }),
    }),
    lexicalProvider,
  };
};

const buildSyncPayloads = (
  input: CreateRuntimeSearchManagerInput,
): Effect.Effect<readonly SearchProviderSyncPayload[], Error, never> =>
  Effect.gen(function* () {
    const catalogs = yield* input.sourceCatalogStore.loadWorkspaceSourceCatalogs({
      scopeId: input.runtimeLocalScope.installation.scopeId,
      actorScopeId: input.runtimeLocalScope.installation.actorScopeId,
    });

    return yield* Effect.forEach(catalogs, (catalogEntry) =>
      Effect.gen(function* () {
        const tools = yield* expandCatalogTools({
          catalogs: [catalogEntry],
          includeSchemas: true,
          includeTypePreviews: true,
        });

        return {
          source: catalogEntry.source,
          providerKey: catalogEntry.source.kind,
          revisionId: catalogEntry.revision.id,
          sourceHash: catalogEntry.revision.snapshotHash,
          generatedAt: catalogEntry.revision.updatedAt,
          documents: tools.map((tool) =>
            searchDocumentFromLoadedTool({
              path: tool.path,
              searchNamespace: tool.searchNamespace,
              searchText: tool.searchText,
              source: tool.source,
              sourceRecord: tool.sourceRecord,
              capabilityId: tool.capabilityId,
              executableId: tool.executableId,
              capability: tool.capability,
              executable: tool.executable,
              descriptor: tool.descriptor,
              projectedCatalog: tool.projectedCatalog,
            }),
          ),
        } satisfies SearchProviderSyncPayload;
      }), { concurrency: "unbounded" });
  });

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const createRuntimeSearchManager = (
  input: CreateRuntimeSearchManagerInput,
): RuntimeSearchManagerShape => {
  const { configuredProviderKey, activeProvider, lexicalProvider } =
    resolveConfiguredProvider(input);
  const bootstrappedProviderKeys = new Set<string>();
  let degradedDetail: string | null = null;

  const bootstrapProvider = (provider: ExecutorSearchProvider) =>
    Effect.gen(function* () {
      if (bootstrappedProviderKeys.has(provider.key)) {
        return;
      }

      yield* Effect.tryPromise({
        try: async () => {
          await provider.init?.();
        },
        catch: toError,
      });

      const payloads = yield* buildSyncPayloads(input);
      yield* Effect.forEach(payloads, (payload) =>
        Effect.tryPromise({
          try: async () => {
            await provider.syncSourceCatalog(payload);
          },
          catch: toError,
        }), { concurrency: "unbounded" });
      bootstrappedProviderKeys.add(provider.key);
    });

  const runWithFallback = <A>(
    operation: string,
    primary: () => Promise<A> | A,
    fallback: () => Promise<A> | A,
    onFallback?: (value: A) => A,
  ) =>
    Effect.tryPromise({
      try: async () => {
        try {
          return await primary();
        } catch (error) {
          degradedDetail = `${operation}: ${toError(error).message}`;
          const fallbackValue = await fallback();
          return onFallback ? onFallback(fallbackValue) : fallbackValue;
        }
      },
      catch: toError,
    });

  const statusFromProvider = (
    provider: ExecutorSearchProvider,
  ): Effect.Effect<SearchProviderStatus, Error, never> =>
    Effect.tryPromise({
      try: async () => {
        const status = await provider.status();
        return {
          ...status,
          configuredProviderKey,
          ...(degradedDetail ? { detail: degradedDetail } : {}),
          healthy: degradedDetail ? false : status.healthy,
        };
      },
      catch: toError,
    });

  return {
    searchWorkspace: (request) =>
      Effect.gen(function* () {
        yield* bootstrapProvider(lexicalProvider);
        if (activeProvider.key !== lexicalProvider.key) {
          yield* bootstrapProvider(activeProvider);
        }

        const lexicalStatus = yield* statusFromProvider(lexicalProvider);
        return yield* runWithFallback(
          "searchWorkspace",
          () => activeProvider.searchWorkspace(request),
          async () =>
            markSearchResultFallback(await lexicalProvider.searchWorkspace(request)),
          (result) => ({
            ...result,
            provider: providerInfoFromStatus(
              activeProvider.key === lexicalProvider.key ? lexicalStatus : {
                ...lexicalStatus,
                providerKey: result.provider.providerKey,
                mode: result.provider.mode,
                backend: result.provider.backend,
              },
              result.provider.fallbackUsed === true,
            ),
          }),
        );
      }).pipe(
        Effect.withSpan("search.provider.search_workspace", {
          attributes: {
            "search.provider.key": configuredProviderKey,
            "query.token_count": request.query.trim().split(/\s+/).filter(Boolean).length,
          },
        }),
      ),

    discoverSource: (request) =>
      Effect.gen(function* () {
        yield* bootstrapProvider(lexicalProvider);
        if (activeProvider.key !== lexicalProvider.key) {
          yield* bootstrapProvider(activeProvider);
        }

        return yield* runWithFallback(
          "discoverSource",
          () => activeProvider.discoverSource(request),
          async () =>
            markSearchResultFallback(await lexicalProvider.discoverSource(request)),
        );
      }).pipe(
        Effect.withSpan("search.provider.discover_source", {
          attributes: {
            "search.provider.key": configuredProviderKey,
            "source.id": request.sourceId,
            "query.token_count": request.query.trim().split(/\s+/).filter(Boolean).length,
          },
        }),
      ),

    syncSourceCatalog: (payload) =>
      Effect.gen(function* () {
        yield* bootstrapProvider(lexicalProvider);
        yield* Effect.tryPromise({
          try: async () => {
            await lexicalProvider.syncSourceCatalog(payload);
          },
          catch: toError,
        });

        if (activeProvider.key === lexicalProvider.key) {
          return;
        }

        yield* bootstrapProvider(activeProvider);
        yield* runWithFallback(
          "syncSourceCatalog",
          () => activeProvider.syncSourceCatalog(payload),
          () => lexicalProvider.syncSourceCatalog(payload),
        );
      }).pipe(
        Effect.withSpan("search.provider.sync_source", {
          attributes: {
            "search.provider.key": configuredProviderKey,
            "source.id": payload.source.id,
            "document.count": payload.documents.length,
          },
        }),
      ),

    removeSource: (payload) =>
      Effect.gen(function* () {
        yield* bootstrapProvider(lexicalProvider);
        yield* Effect.tryPromise({
          try: async () => {
            await lexicalProvider.removeSource(payload);
          },
          catch: toError,
        });

        if (activeProvider.key === lexicalProvider.key) {
          return;
        }

        yield* bootstrapProvider(activeProvider);
        yield* runWithFallback(
          "removeSource",
          () => activeProvider.removeSource(payload),
          () => lexicalProvider.removeSource(payload),
        );
      }).pipe(
        Effect.withSpan("search.provider.remove_source", {
          attributes: {
            "search.provider.key": configuredProviderKey,
            "source.id": payload.sourceId,
          },
        }),
      ),

    status: () =>
      Effect.gen(function* () {
        yield* bootstrapProvider(lexicalProvider);
        if (activeProvider.key !== lexicalProvider.key) {
          yield* Effect.catchAll(
            bootstrapProvider(activeProvider),
            (cause) => {
              degradedDetail = `bootstrap: ${toError(cause).message}`;
              return Effect.void;
            },
          );
        }

        return yield* Effect.catchAll(
          statusFromProvider(activeProvider),
          () => statusFromProvider(lexicalProvider),
        );
      }),

    refresh: () =>
      Effect.gen(function* () {
        yield* bootstrapProvider(lexicalProvider);
        if (activeProvider.key === lexicalProvider.key) {
          return yield* Effect.tryPromise({
            try: async () => lexicalProvider.refresh(),
            catch: toError,
          });
        }

        return yield* runWithFallback(
          "refresh",
          () => activeProvider.refresh(),
          () => lexicalProvider.refresh(),
        );
      }).pipe(
        Effect.withSpan("search.provider.refresh", {
          attributes: {
            "search.provider.key": configuredProviderKey,
          },
        }),
      ),

    rebuild: () =>
      Effect.gen(function* () {
        yield* bootstrapProvider(lexicalProvider);
        if (activeProvider.key === lexicalProvider.key) {
          return yield* Effect.tryPromise({
            try: async () => lexicalProvider.rebuild(),
            catch: toError,
          });
        }

        return yield* runWithFallback(
          "rebuild",
          () => activeProvider.rebuild(),
          () => lexicalProvider.rebuild(),
        );
      }).pipe(
        Effect.withSpan("search.provider.rebuild", {
          attributes: {
            "search.provider.key": configuredProviderKey,
          },
        }),
      ),
  };
};

export const RuntimeSearchManagerLive = Layer.effect(
  RuntimeSearchManagerService,
  Effect.gen(function* () {
    const runtimeLocalScope = yield* RuntimeLocalScopeService;
    const pluginRegistry = yield* ExecutorPluginRegistryService;
    const sourceCatalogStore = yield* RuntimeSourceCatalogStoreService;

    return RuntimeSearchManagerService.of(
      createRuntimeSearchManager({
        runtimeLocalScope,
        pluginRegistry,
        sourceCatalogStore,
      }),
    );
  }),
);
