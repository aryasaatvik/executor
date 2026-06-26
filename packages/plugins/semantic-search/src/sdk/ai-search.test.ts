import { describe, expect, it } from "@effect/vitest";
import type { AiSearchInstance } from "@cloudflare/workers-types";
import { type PluginStorageCollectionFacade, type PluginStorageEntry } from "@executor-js/sdk/core";
import { Effect } from "effect";

import {
  DEFAULT_AI_SEARCH_EMBEDDING_MODEL,
  makeAiSearchToolDiscoveryProvider,
  reindexAiSearch,
} from "./ai-search";
import { type aiSearchItems, type AiSearchItemRow } from "./collections";

type ItemsCollection = PluginStorageCollectionFacade<typeof aiSearchItems>;

const fixedDate = new Date("2026-06-25T00:00:00.000Z");

const githubRow: PluginStorageEntry<AiSearchItemRow> = {
  id: "entry:github.default.main.repos.create",
  owner: "org",
  pluginId: "semantic-search",
  collection: "aiSearchItems",
  key: "github.default.main.repos.create",
  data: {
    path: "github.default.main.repos.create",
    key: "github.repos.create.md",
    itemId: "item:github.repos.create.md",
    name: "repos.create",
    description: "Create a repository",
    integration: "github",
    fingerprint: "github-fingerprint",
    status: "queued",
    updatedAt: "2026-06-25T00:00:00.000Z",
  },
  createdAt: fixedDate,
  updatedAt: fixedDate,
};

const unusedEffect = <A>(): Effect.Effect<A> =>
  Effect.sync(() => expect.unreachable("Unexpected plugin storage test call"));

const makeItemsCollection = (overrides: Partial<ItemsCollection>): ItemsCollection => ({
  get: () => unusedEffect(),
  getMany: () => unusedEffect(),
  getForOwner: () => unusedEffect(),
  getManyForOwner: () => unusedEffect(),
  list: () => unusedEffect(),
  put: () => unusedEffect(),
  putMany: () => unusedEffect(),
  query: () => unusedEffect(),
  count: () => unusedEffect(),
  queryKeyset: () => unusedEffect(),
  aggregate: {
    count: () => unusedEffect(),
    groupCount: () => unusedEffect(),
    timeBuckets: () => unusedEffect(),
    stats: () => unusedEffect(),
  },
  remove: () => unusedEffect(),
  removeMany: () => unusedEffect(),
  ...overrides,
});

const makeAiSearchItems = () =>
  ({
    upload: async (name) => ({ id: `item:${name}`, key: name, status: "queued" }),
    list: async () => ({
      result: [],
      result_info: { count: 0, total_count: 0, page: 1, per_page: 50 },
    }),
    delete: async () => {},
    uploadAndPoll: async (name) => ({ id: `item:${name}`, key: name, status: "queued" }),
    get: () => expect.unreachable("Unexpected AI Search item lookup"),
  }) satisfies Pick<AiSearchInstance, "items">["items"];

const makeAiSearch = (): Pick<AiSearchInstance, "items" | "search" | "info"> => ({
  info: async () => ({
    id: "executor-tool-search",
    embedding_model: DEFAULT_AI_SEARCH_EMBEDDING_MODEL,
  }),
  items: makeAiSearchItems(),
  search: async () => ({
    search_query: "create repo",
    chunks: [
      {
        id: "chunk-1",
        type: "text",
        score: 0.7,
        text: "create a repository",
        item: {
          key: "github.repos.create.md",
          metadata: {
            path: "github.default.main.repos.create",
            name: "repos.create",
            description: "Create a repository",
            integration: "github",
          },
        },
      },
      {
        id: "chunk-2",
        type: "text",
        score: 0.9,
        text: "github repository creation",
        item: {
          key: "github.repos.create.md",
          metadata: {
            path: "github.default.main.repos.create",
            name: "repos.create",
            description: "Create a repository",
            integration: "github",
          },
        },
      },
      {
        id: "chunk-3",
        type: "text",
        score: 0.8,
        text: "send a message",
        item: {
          key: "slack.messages.send.md",
          metadata: {
            path: "slack.default.main.messages.send",
            name: "messages.send",
            description: "Send a message",
            integration: "slack",
          },
        },
      },
    ],
  }),
});

describe("makeAiSearchToolDiscoveryProvider", () => {
  it.effect("collapses multiple AI Search chunks for the same tool to the best score", () =>
    Effect.gen(function* () {
      const provider = makeAiSearchToolDiscoveryProvider({
        aiSearch: makeAiSearch(),
        items: undefined,
      });

      const page = yield* provider!.searchTools({
        executor: undefined as never,
        query: "create repo",
        limit: 10,
        offset: 0,
      });

      expect(page.items.map((item) => item.path)).toEqual([
        "github.default.main.repos.create",
        "slack.default.main.messages.send",
      ]);
      expect(page.items[0]?.score).toBe(0.9);
      expect(page.items[0]?.description).toBe("Create a repository");
      expect(page.total).toBe(2);
    }),
  );

  it.effect("filters by explicit tool path prefix without defaulting to the tenant namespace", () =>
    Effect.gen(function* () {
      const provider = makeAiSearchToolDiscoveryProvider({
        aiSearch: makeAiSearch(),
        items: undefined,
      });

      const unfiltered = yield* provider!.searchTools({
        executor: undefined as never,
        query: "tool",
        limit: 10,
        offset: 0,
      });
      const filtered = yield* provider!.searchTools({
        executor: undefined as never,
        query: "tool",
        namespace: "github",
        limit: 10,
        offset: 0,
      });

      expect(unfiltered.items).toHaveLength(2);
      expect(filtered.items.map((item) => item.path)).toEqual(["github.default.main.repos.create"]);
    }),
  );

  it.effect("ignores AI Search chunks whose item key is not tracked locally", () =>
    Effect.gen(function* () {
      const provider = makeAiSearchToolDiscoveryProvider({
        aiSearch: makeAiSearch(),
        items: makeItemsCollection({ list: () => Effect.succeed([githubRow]) }),
      });

      const page = yield* provider!.searchTools({
        executor: undefined as never,
        query: "tool",
        limit: 10,
        offset: 0,
      });

      expect(page.items.map((item) => item.path)).toEqual(["github.default.main.repos.create"]);
      expect(page.total).toBe(1);
    }),
  );
});

describe("reindexAiSearch", () => {
  it.effect("indexes an identity document when schema collection fails", () =>
    Effect.gen(function* () {
      let uploadedContent = "";
      const stored: AiSearchItemRow[] = [];

      const result = yield* reindexAiSearch({
        executor: {
          tools: {
            manifest: () =>
              Effect.succeed([
                {
                  path: "github.default.main.repos.create",
                  name: "repos.create",
                  description: "Create a repository",
                  integration: "github",
                  fingerprintVersion: "v1",
                  indexFingerprint: "fingerprint",
                },
              ]),
            schema: () => Effect.fail("schema unavailable"),
          },
        } as never,
        aiSearch: {
          ...makeAiSearch(),
          items: {
            ...makeAiSearchItems(),
            upload: async (name, content) => {
              uploadedContent = String(content);
              return { id: `item:${name}`, key: name, status: "queued" };
            },
          },
        },
        items: makeItemsCollection({
          list: () => Effect.succeed([]),
          put: ({ data }) =>
            Effect.sync(() => {
              stored.push(data);
              return { ...githubRow, data };
            }),
        }),
        owner: "org",
        namespace: "org",
      });

      expect(result).toMatchObject({ indexed: 1, skipped: 0, removed: 0 });
      expect(uploadedContent).toContain("# github.default.main.repos.create");
      expect(uploadedContent).toContain("Description: Create a repository");
      expect(uploadedContent).not.toContain("Input schema");
      expect(stored[0]?.fingerprint).toBe("github.default.main.repos.create:v1:fingerprint:");
    }),
  );

  it.effect(
    "fails before indexing when the AI Search instance uses a different embedding model",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          reindexAiSearch({
            executor: {
              tools: {
                manifest: () =>
                  Effect.succeed([
                    {
                      path: "github.default.main.repos.create",
                      name: "repos.create",
                      description: "Create a repository",
                      integration: "github",
                      fingerprintVersion: "v1",
                      indexFingerprint: "fingerprint",
                    },
                  ]),
              },
            } as never,
            aiSearch: {
              ...makeAiSearch(),
              info: async () => ({
                id: "executor-tool-search",
                embedding_model: "@cf/baai/bge-base-en-v1.5",
              }),
            },
            items: makeItemsCollection({
              list: () => Effect.sync(() => expect.unreachable("list should not run")),
            }),
            owner: "org",
            namespace: "org",
          }),
        );

        expect(error).toMatchObject({
          message: expect.stringContaining(DEFAULT_AI_SEARCH_EMBEDDING_MODEL),
        });
      }),
  );

  it.effect("removes stale rows even when deleting the remote AI Search item fails", () =>
    Effect.gen(function* () {
      const removed: string[] = [];
      const result = yield* reindexAiSearch({
        executor: {
          tools: {
            manifest: () => Effect.succeed([]),
          },
        } as never,
        aiSearch: {
          ...makeAiSearch(),
          items: {
            ...makeAiSearchItems(),
            delete: async () => {
              // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: test double for rejected AI Search delete promise
              throw new Error("delete failed");
            },
          },
        },
        items: makeItemsCollection({
          list: () => Effect.succeed([githubRow]),
          remove: ({ key }) =>
            Effect.sync(() => {
              removed.push(key);
            }),
        }),
        owner: "org",
        namespace: "org",
      });

      expect(result.removed).toBe(1);
      expect(removed).toEqual(["github.default.main.repos.create"]);
    }),
  );
});
