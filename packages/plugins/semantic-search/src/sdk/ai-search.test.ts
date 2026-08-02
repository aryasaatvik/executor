import { describe, expect, it } from "@effect/vitest";
import type { AiSearchInstance } from "@cloudflare/workers-types";
import { type PluginStorageCollectionFacade, type PluginStorageEntry } from "@executor-js/sdk/core";
import { Effect } from "effect";

import {
  makeAiSearchToolDiscoveryProvider,
  reindexAiSearch,
  reindexAiSearchBatch,
  statusAiSearch,
} from "./ai-search";
import { type aiSearchItems, type AiSearchItemRow } from "./collections";
import { cyrb53 } from "./fingerprint";

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
  getManyForOwner: () => Effect.succeed(new Map()),
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
    get: (itemId) => ({
      info: async () => ({ id: itemId, key: itemId.replace(/^item:/, ""), status: "queued" }),
      download: async () => expect.unreachable("Unexpected AI Search item download"),
    }),
  }) satisfies Pick<AiSearchInstance, "items">["items"];

const makeAiSearch = (): Pick<AiSearchInstance, "items" | "search" | "stats"> => ({
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
  stats: async () => ({}),
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

  it.effect("reconciles a provider-rewritten item key by canonical path", () =>
    Effect.gen(function* () {
      const provider = makeAiSearchToolDiscoveryProvider({
        aiSearch: {
          ...makeAiSearch(),
          search: async () => ({
            search_query: "create repo",
            chunks: [
              {
                id: "chunk-1",
                type: "text",
                score: 0.7,
                text: "create a repository",
                item: {
                  key: "provider-rewritten-key.md",
                  metadata: {
                    path: githubRow.key,
                    name: githubRow.data.name,
                    description: githubRow.data.description,
                    integration: githubRow.data.integration,
                  },
                },
              },
            ],
          }),
        },
        items: makeItemsCollection({
          getMany: ({ keys }) =>
            Effect.succeed(
              new Map(
                keys.flatMap((key) => (key === githubRow.key ? [[key, githubRow] as const] : [])),
              ),
            ),
        }),
      });

      const page = yield* provider!.searchTools({
        executor: undefined as never,
        query: "create repo",
        limit: 10,
        offset: 0,
      });

      expect(page.items).toMatchObject([
        {
          path: githubRow.key,
          name: githubRow.data.name,
          score: 0.7,
        },
      ]);
    }),
  );

  it.effect("ignores AI Search chunks whose paths are not current locally", () =>
    Effect.gen(function* () {
      const provider = makeAiSearchToolDiscoveryProvider({
        aiSearch: makeAiSearch(),
        items: makeItemsCollection({
          getMany: ({ keys }) =>
            Effect.succeed(
              new Map(
                keys.flatMap((key) => (key === githubRow.key ? [[key, githubRow] as const] : [])),
              ),
            ),
        }),
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

  it.effect("returns an empty page when no returned paths are current locally", () =>
    Effect.gen(function* () {
      const provider = makeAiSearchToolDiscoveryProvider({
        aiSearch: makeAiSearch(),
        items: makeItemsCollection({ getMany: () => Effect.succeed(new Map()) }),
      });

      const page = yield* provider!.searchTools({
        executor: undefined as never,
        query: "tool",
        limit: 10,
        offset: 0,
      });

      expect(page).toMatchObject({ items: [], total: 0, hasMore: false, nextOffset: null });
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
          putMany: ({ entries }) =>
            Effect.sync(() => {
              stored.push(...entries.map((entry) => entry.data));
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
            ...makeAiSearchItems(),
            delete: async () => {
              // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: test double for rejected AI Search delete promise
              throw new Error("delete failed");
            },
          },
        },
        items: makeItemsCollection({
          list: () => Effect.succeed([githubRow]),
          removeMany: ({ keys }) =>
            Effect.sync(() => {
              removed.push(...keys);
            }),
        }),
        owner: "org",
        namespace: "org",
      });

      expect(result.removed).toBe(1);
      expect(removed).toEqual(["github.default.main.repos.create"]);
    }),
  );

  it.effect("batches local row writes before deleting replaced remote items", () =>
    Effect.gen(function* () {
      const deleted: string[] = [];
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
                  indexFingerprint: "new-fingerprint",
                },
              ]),
            schema: () => Effect.fail("schema unavailable"),
          },
        } as never,
        aiSearch: {
          ...makeAiSearch(),
          items: {
            ...makeAiSearchItems(),
            upload: async (name) => ({ id: `new:${name}`, key: name, status: "queued" }),
            delete: async (id) => {
              deleted.push(id);
            },
          },
        },
        items: makeItemsCollection({
          getManyForOwner: () => Effect.succeed(new Map([[githubRow.key, githubRow]])),
          list: () => Effect.succeed([githubRow]),
          putMany: ({ entries }) =>
            Effect.sync(() => {
              stored.push(...entries.map((entry) => entry.data));
            }),
        }),
        owner: "org",
        namespace: "org",
      });

      expect(result).toMatchObject({ indexed: 1, skipped: 0, removed: 0 });
      expect(stored[0]?.itemId).toMatch(/^new:tool-[a-z0-9]+\.md$/);
      expect(stored[0]?.key).toBe(stored[0]?.itemId.replace(/^new:/, ""));
      expect(deleted).toEqual(["item:github.repos.create.md"]);
    }),
  );

  it.effect("records uploaded rows in bounded batches", () =>
    Effect.gen(function* () {
      const putManySizes: number[] = [];
      const manifests = Array.from({ length: 55 }, (_, index) => ({
        path: `github.default.main.repos.tool${index}`,
        name: `repos.tool${index}`,
        description: "Repository tool",
        integration: "github",
        fingerprintVersion: "v1",
        indexFingerprint: `fingerprint-${index}`,
      }));

      const result = yield* reindexAiSearch({
        executor: {
          tools: {
            manifest: () => Effect.succeed(manifests),
            schema: () => Effect.fail("schema unavailable"),
          },
        } as never,
        aiSearch: {
          ...makeAiSearch(),
          items: {
            ...makeAiSearchItems(),
            upload: async (name) => ({ id: `item:${name}`, key: name, status: "queued" }),
          },
        },
        items: makeItemsCollection({
          list: () => Effect.succeed([]),
          putMany: ({ entries }) =>
            Effect.sync(() => {
              putManySizes.push(entries.length);
            }),
        }),
        owner: "org",
        namespace: "org",
      });

      expect(result.indexed).toBe(55);
      expect(putManySizes).toEqual([25, 25, 5]);
    }),
  );

  it.effect("reuses a completed remote item for an unchanged local row", () =>
    Effect.gen(function* () {
      const manifest = {
        path: "github.default.main.repos.create",
        name: "repos.create",
        description: "Create a repository",
        integration: "github",
        fingerprintVersion: "v1",
        indexFingerprint: "fingerprint",
      };
      const fingerprint = "github.default.main.repos.create:v1:fingerprint:";
      const itemName = `tool-${cyrb53(`${manifest.path}\u0000${fingerprint}`).toString(36)}.md`;
      const existing = {
        ...githubRow,
        data: {
          ...githubRow.data,
          key: itemName,
          itemId: `remote:${itemName}`,
          fingerprint,
        },
      };

      const result = yield* reindexAiSearchBatch({
        executor: {
          tools: {
            manifest: () => Effect.succeed([manifest]),
            schema: () => Effect.fail("schema unavailable"),
          },
        } as never,
        aiSearch: {
          ...makeAiSearch(),
          items: {
            ...makeAiSearchItems(),
            get: () => ({
              info: async () => ({
                id: existing.data.itemId,
                key: existing.data.key,
                status: "completed",
              }),
              download: async () => expect.unreachable("Unexpected AI Search item download"),
            }),
            upload: async () => expect.unreachable("Existing remote item should be reused"),
          },
        },
        items: makeItemsCollection({
          getManyForOwner: () => Effect.succeed(new Map([[manifest.path, existing]])),
          list: () => Effect.succeed([existing]),
        }),
        owner: "org",
        namespace: "org",
        offset: 0,
        pageSize: 128,
      });

      expect(result).toMatchObject({ indexed: 0, skipped: 1 });
    }),
  );

  it.effect("indexes one requested batch and returns the next offset", () =>
    Effect.gen(function* () {
      const stored: string[] = [];
      const manifests = Array.from({ length: 130 }, (_, index) => ({
        path: `github.default.main.repos.tool${index}`,
        name: `repos.tool${index}`,
        description: "Repository tool",
        integration: "github",
        fingerprintVersion: "v1",
        indexFingerprint: `fingerprint-${index}`,
      }));

      const result = yield* reindexAiSearchBatch({
        executor: {
          tools: {
            manifest: () => Effect.succeed(manifests),
            schema: () => Effect.fail("schema unavailable"),
          },
        } as never,
        aiSearch: {
          ...makeAiSearch(),
          items: {
            ...makeAiSearchItems(),
            upload: async (name) => ({ id: `item:${name}`, key: name, status: "queued" }),
          },
        },
        items: makeItemsCollection({
          list: () => Effect.succeed([]),
          putMany: ({ entries }) =>
            Effect.sync(() => {
              stored.push(...entries.map((entry) => entry.key));
            }),
        }),
        owner: "org",
        namespace: "org",
        offset: 0,
        pageSize: 128,
      });

      expect(result).toMatchObject({
        total: 130,
        indexed: 128,
        skipped: 0,
        removed: 0,
        offset: 0,
        pageSize: 128,
        nextOffset: 128,
      });
      expect(stored).toHaveLength(128);
    }),
  );

  it.effect("retries rows whose remote AI Search item is errored", () =>
    Effect.gen(function* () {
      let uploadCount = 0;
      const manifest = {
        path: "github.default.main.repos.create",
        name: "repos.create",
        description: "Create a repository",
        integration: "github",
        fingerprintVersion: "v1",
        indexFingerprint: "fingerprint",
      };
      const existing = {
        ...githubRow,
        data: {
          ...githubRow.data,
          fingerprint: "github.default.main.repos.create:v1:fingerprint:",
        },
      };

      const result = yield* reindexAiSearch({
        executor: {
          tools: {
            manifest: () => Effect.succeed([manifest]),
            schema: () => Effect.fail("schema unavailable"),
          },
        } as never,
        aiSearch: {
          ...makeAiSearch(),
          items: {
            ...makeAiSearchItems(),
            get: () => ({
              info: async () => ({
                id: existing.data.itemId,
                key: existing.data.key,
                status: "error",
              }),
              download: async () => expect.unreachable("Unexpected AI Search item download"),
            }),
            upload: async (name) => {
              uploadCount += 1;
              return { id: `retry:${name}`, key: name, status: "queued" };
            },
          },
        },
        items: makeItemsCollection({
          getManyForOwner: () => Effect.succeed(new Map([[manifest.path, existing]])),
          list: () => Effect.succeed([existing]),
          putMany: () => Effect.void,
        }),
        owner: "org",
        namespace: "org",
      });

      expect(result).toMatchObject({ indexed: 1, skipped: 0 });
      expect(uploadCount).toBe(1);
    }),
  );

  it.effect("reads status from instance statistics without listing every remote item", () =>
    Effect.gen(function* () {
      const status = yield* statusAiSearch({
        aiSearch: {
          stats: async () => ({
            queued: 2,
            running: 3,
            completed: 4,
            error: 5,
            skipped: 6,
            outdated: 7,
            last_activity: "2026-08-02T00:00:00.000Z",
          }),
        },
        items: makeItemsCollection({
          list: () => Effect.succeed([githubRow]),
        }),
        namespace: "org",
      });

      expect(status).toEqual({
        namespace: "org",
        indexed: 1,
        lexical: null,
        queued: 2,
        running: 3,
        completed: 4,
        error: 5,
        skipped: 6,
        outdated: 7,
        lastActivity: "2026-08-02T00:00:00.000Z",
      });
    }),
  );

  it.effect("uses a bounded AI Search item name for long tool paths", () =>
    Effect.gen(function* () {
      const uploadedNames: string[] = [];
      const longPath = [
        "cloudflare_api",
        "org",
        "aryalabs",
        "accessBookmarkApplicationsDeprecated",
        "accessBookmarkApplicationsDeprecatedCreateABookmarkApplication",
      ].join(".");

      yield* reindexAiSearch({
        executor: {
          tools: {
            manifest: () =>
              Effect.succeed([
                {
                  path: longPath,
                  name: "Create a bookmark application",
                  description: "Create a bookmark application",
                  integration: "cloudflare_api",
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
            upload: async (name) => {
              uploadedNames.push(name);
              return { id: `item:${name}`, key: name, status: "queued" };
            },
          },
        },
        items: makeItemsCollection({
          list: () => Effect.succeed([]),
          putMany: () => Effect.void,
        }),
        owner: "org",
        namespace: "org",
      });

      expect(uploadedNames).toHaveLength(1);
      expect(uploadedNames[0]).toMatch(/^tool-[a-z0-9]+\.md$/);
      expect(uploadedNames[0]?.length).toBeLessThan(64);
    }),
  );
});
