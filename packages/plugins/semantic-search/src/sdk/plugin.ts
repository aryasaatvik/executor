import { definePlugin, type Executor } from "@executor-js/sdk/core";
import { Effect } from "effect";

import { makeAiSearchToolDiscoveryProvider, reindexAiSearch, statusAiSearch } from "./ai-search";
import { aiSearchItems } from "./collections";
import { SemanticSearchError } from "./errors";
import type { AiSearchInstance, SemanticSearchStatus } from "./ai-search";

export interface SemanticSearchPluginOptions {
  readonly aiSearch?: AiSearchInstance;
  readonly namespace?: string;
  readonly maxTools?: number;
}

export interface SemanticSearchResultPage {
  readonly namespace: string;
  readonly query: string;
  readonly items: readonly {
    readonly path: string;
    readonly name: string;
    readonly description?: string;
    readonly integration: string;
    readonly score: number;
  }[];
}

const notConfiguredStatus = (namespace: string): SemanticSearchStatus => ({
  namespace,
  indexed: 0,
  queued: 0,
  running: 0,
  completed: 0,
  error: 0,
  skipped: 0,
  outdated: 0,
});

const makeSemanticSearchExtension = (input: {
  readonly aiSearch: AiSearchInstance | undefined;
  readonly items: Parameters<typeof reindexAiSearch>[0]["items"];
  readonly owner: "user" | "org";
  readonly namespace: string;
  readonly maxTools?: number;
}) => ({
  reindex: (executor: Executor) =>
    reindexAiSearch({
      executor,
      aiSearch: input.aiSearch,
      items: input.items,
      owner: input.owner,
      namespace: input.namespace,
      maxTools: input.maxTools,
    }),
  search: (
    executor: Executor,
    searchInput: { readonly query: string; readonly namespace?: string; readonly limit?: number },
  ) => {
    const provider = makeAiSearchToolDiscoveryProvider({
      aiSearch: input.aiSearch,
      items: input.items,
      namespace: input.namespace,
    });
    return provider
      ? provider
          .searchTools({
            executor,
            query: searchInput.query,
            namespace: searchInput.namespace,
            limit: searchInput.limit ?? 20,
            offset: 0,
          })
          .pipe(
            Effect.map(
              (page): SemanticSearchResultPage => ({
                namespace: input.namespace,
                query: searchInput.query,
                items: page.items,
              }),
            ),
            Effect.mapError(
              (cause) =>
                new SemanticSearchError({ message: "Semantic search query failed.", cause }),
            ),
          )
      : Effect.fail(
          new SemanticSearchError({
            message: "Semantic search is not configured (missing AI Search).",
          }),
        );
  },
  status: () =>
    input.aiSearch
      ? statusAiSearch({ aiSearch: input.aiSearch, items: input.items, namespace: input.namespace })
      : Effect.succeed(notConfiguredStatus(input.namespace)),
});

export const semanticSearchPlugin = definePlugin((options?: SemanticSearchPluginOptions) => {
  const namespace = options?.namespace ?? "default";
  const aiSearch = options?.aiSearch;
  const maxTools = options?.maxTools;

  return {
    id: "semanticSearch" as const,
    packageName: "@executor-js/plugin-semantic-search",
    pluginStorage: { aiSearchItems },
    storage: (deps) => ({
      aiSearchItems: deps.pluginStorage.collection(aiSearchItems),
      owner: "org" as const,
    }),
    extension: (ctx) =>
      makeSemanticSearchExtension({
        aiSearch,
        items: ctx.storage.aiSearchItems,
        owner: ctx.storage.owner,
        namespace,
        maxTools,
      }),
    runtime: {
      toolDiscoveryProvider: () =>
        makeAiSearchToolDiscoveryProvider({
          aiSearch,
          items: undefined,
          namespace,
        }),
    },
  };
});

export type SemanticSearchExtension = ReturnType<typeof makeSemanticSearchExtension>;
