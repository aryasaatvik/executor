import { describe, expect, it } from "@effect/vitest";
import { type PluginStorageCollectionFacade, type PluginStorageEntry } from "@executor-js/sdk/core";
import { Effect } from "effect";

import {
  makeAiSearchToolDiscoveryProvider,
  reindexAiSearch,
  type AiSearchInstance,
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

const makeAiSearch = (): AiSearchInstance => ({
  items: {
    upload: async (name) => ({ id: `item:${name}`, key: name }),
    list: async () => ({ result: [], result_info: { total_count: 0, page: 1, per_page: 50 } }),
    delete: async () => {},
  },
  search: async () => ({
    chunks: [
      {
        id: "chunk-1",
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
            ...makeAiSearch().items,
            upload: async (name, content) => {
              uploadedContent = String(content);
              return { id: `item:${name}`, key: name };
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
            ...makeAiSearch().items,
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
