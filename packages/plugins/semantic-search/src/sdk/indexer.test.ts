import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type {
  Executor,
  Owner,
  PluginStorageCollectionFacade,
  PluginStorageEntry,
} from "@executor-js/sdk/core";

import { makeFacetChunker } from "./chunker";
import type { FingerprintRow } from "./collections";
import { toolFingerprints } from "./collections";
import type { ToolEmbedder } from "./embedder";
import { reconcileToolCatalog, reconcileToolCatalogPage, sweepRemoved } from "./indexer";
import type { VectorStore, VectorInput } from "./store";
import type { FtsDocumentInput, FtsLexicalStore } from "./store-fts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal fake Executor that exposes a fixed tool list + schema map. */
const makeExecutor = (
  tools: ReadonlyArray<{
    address: string;
    name: string;
    integration: string;
    description: string;
    inputTypeScript?: string;
    outputTypeScript?: string;
  }>,
  schemas: Map<string, { inputTypeScript?: string; outputTypeScript?: string }> = new Map(),
): Executor => {
  const toolObjects = tools.map((t) => ({
    address: t.address as never,
    name: t.name as never,
    integration: t.integration as never,
    description: t.description,
    owner: "org" as never,
    connection: "default" as never,
    pluginId: "test",
  }));
  // oxlint-disable-next-line executor/no-double-cast -- test stub: only the exercised methods are implemented
  return {
    tools: {
      list: () => Effect.succeed(toolObjects as never),
      schema: (address: never) => {
        const addrStr = String(address);
        const key = addrStr.startsWith("tools.") ? addrStr.slice(6) : addrStr;
        const view = schemas.get(key) ?? null;
        if (view === null) return Effect.succeed(null);
        return Effect.succeed({
          address: address as never,
          ...view,
        });
      },
    },
  } as unknown as Executor;
};

/** Build a fake VectorStore that records upserts and deletes. */
const makeStore = () => {
  const upserted: VectorInput[] = [];
  const deleted: string[] = [];
  const store: VectorStore = {
    maxTopK: 200,
    query: () => Effect.succeed([]),
    upsert: (vectors) =>
      Effect.sync(() => {
        upserted.push(...vectors);
      }),
    deleteByIds: (ids) =>
      Effect.sync(() => {
        deleted.push(...ids);
      }),
  };
  return { store, upserted, deleted };
};

/** Build a fake FtsLexicalStore that records upserts/deletes. */
const makeFakeLexical = () => {
  const upserted: FtsDocumentInput[] = [];
  const deleted: string[] = [];
  const store: FtsLexicalStore = {
    upsert: (docs) =>
      Effect.sync(() => {
        upserted.push(...docs);
      }),
    deleteByIds: (ids) =>
      Effect.sync(() => {
        deleted.push(...ids);
      }),
    search: () => Effect.succeed([]),
    count: () => Effect.succeed(upserted.length),
  };
  return { store, upserted, deleted };
};

/** Build a fake PluginStorageCollectionFacade backed by an in-test Map. */
const makeFingerprints = (
  initial: Map<string, FingerprintRow> = new Map(),
): PluginStorageCollectionFacade<typeof toolFingerprints> => {
  const storage = new Map<string, FingerprintRow>(initial);
  let idCounter = 0;

  const makeEntry = (key: string, data: FingerprintRow): PluginStorageEntry<FingerprintRow> => ({
    id: String(idCounter++),
    owner: "org" as Owner,
    pluginId: "vectorize-search",
    collection: "toolFingerprints",
    key,
    data,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  // oxlint-disable-next-line executor/no-double-cast -- test stub: only the exercised methods are implemented
  return {
    get: ({ key }: { key: string }) =>
      Effect.succeed(storage.has(key) ? makeEntry(key, storage.get(key)!) : null),
    getForOwner: ({ key }: { key: string }) =>
      Effect.succeed(storage.has(key) ? makeEntry(key, storage.get(key)!) : null),
    list: () => Effect.succeed([...storage.entries()].map(([key, data]) => makeEntry(key, data))),
    put: ({ key, data }: { key: string; owner: string; data: unknown }) => {
      storage.set(key, data as FingerprintRow);
      return Effect.succeed(makeEntry(key, data as FingerprintRow));
    },
    query: (input?: { where?: unknown }) => {
      let entries = [...storage.entries()].map(([key, data]) => makeEntry(key, data));
      if (input?.where) {
        // Simple path-eq filter for tests.
        const where = input.where as Record<string, unknown>;
        if (typeof where["path"] === "string") {
          entries = entries.filter((e) => e.data.path === where["path"]);
        }
      }
      return Effect.succeed(entries);
    },
    count: () => Effect.succeed(storage.size),
    queryKeyset: () => Effect.succeed({ entries: [], nextCursor: null }),
    aggregate: {
      count: () => Effect.succeed(storage.size),
      groupCount: () => Effect.succeed([]),
      timeBuckets: () => Effect.succeed([]),
      stats: () => Effect.succeed({ count: 0, min: null, max: null, percentiles: [] }),
    },
    remove: ({ key }: { key: string }) =>
      Effect.sync(() => {
        storage.delete(key);
      }),
  } as unknown as PluginStorageCollectionFacade<typeof toolFingerprints>;
};

const owner: Owner = "org" as Owner;
const namespace = "test-ns";
const chunker = makeFacetChunker();
const fakeEmbedder: ToolEmbedder = {
  model: "test",
  dimensions: 3,
  embedDocuments: (texts) => Effect.succeed(texts.map(() => [0.1, 0.2, 0.3])),
  embedQuery: () => Effect.succeed([1, 0, 0]),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reconcileToolCatalog", () => {
  it.effect("first run: embeds and upserts all tools, writes fingerprint rows", () =>
    Effect.gen(function* () {
      const { store, upserted, deleted } = makeStore();
      const fingerprints = makeFingerprints();

      const result = yield* reconcileToolCatalog({
        namespace,
        executor: makeExecutor([
          {
            address: "tools.github.repos.get",
            name: "repos.get",
            integration: "github",
            description: "Get a repository",
          },
          {
            address: "tools.github.repos.list",
            name: "repos.list",
            integration: "github",
            description: "List repositories",
          },
        ]),
        embedder: fakeEmbedder,
        store,
        chunker,
        fingerprints,
        owner,
      });

      expect(result.total).toBe(2);
      expect(result.reembedded).toBe(2);
      expect(result.unchanged).toBe(0);
      expect(result.removed).toBe(0);
      // Each tool produces at least 1 identity chunk.
      expect(upserted.length).toBeGreaterThanOrEqual(2);
      expect(deleted).toHaveLength(0);
      // All upserted records belong to our namespace.
      for (const v of upserted) {
        expect(v.namespace).toBe(namespace);
      }
    }),
  );

  it.effect("second run with no changes: reembeds nothing, unchanged equals total", () =>
    Effect.gen(function* () {
      const executor = makeExecutor([
        {
          address: "tools.github.repos.get",
          name: "repos.get",
          integration: "github",
          description: "Get a repository",
        },
      ]);

      // First run to populate fingerprints.
      const fingerprints = makeFingerprints();
      const { store: store1 } = makeStore();
      yield* reconcileToolCatalog({
        namespace,
        executor,
        embedder: fakeEmbedder,
        store: store1,
        chunker,
        fingerprints,
        owner,
      });

      // Second run — same executor, same data.
      const { store: store2, upserted: upserted2 } = makeStore();
      const result2 = yield* reconcileToolCatalog({
        namespace,
        executor,
        embedder: fakeEmbedder,
        store: store2,
        chunker,
        fingerprints,
        owner,
      });

      expect(result2.total).toBe(1);
      expect(result2.reembedded).toBe(0);
      expect(result2.unchanged).toBe(1);
      expect(upserted2).toHaveLength(0);
    }),
  );

  it.effect(
    "changing one tool's description re-embeds only that tool AND deletes old chunk ids",
    () =>
      Effect.gen(function* () {
        const executor1 = makeExecutor([
          {
            address: "tools.github.repos.get",
            name: "repos.get",
            integration: "github",
            description: "Get a repository",
          },
          {
            address: "tools.github.repos.list",
            name: "repos.list",
            integration: "github",
            description: "List repositories",
          },
        ]);

        // First run.
        const fingerprints = makeFingerprints();
        const { store: store1, upserted: upserted1 } = makeStore();
        yield* reconcileToolCatalog({
          namespace,
          executor: executor1,
          embedder: fakeEmbedder,
          store: store1,
          chunker,
          fingerprints,
          owner,
        });

        // Capture old chunk ids for repos.get.
        const oldGetChunkIds = upserted1
          .filter((v) => v.metadata?.["path"] === "github.repos.get")
          .map((v) => v.id);
        expect(oldGetChunkIds.length).toBeGreaterThan(0);

        // Second run — repos.get description changed; repos.list is unchanged.
        const executor2 = makeExecutor([
          {
            address: "tools.github.repos.get",
            name: "repos.get",
            integration: "github",
            description: "Fetch a repository — updated description",
          },
          {
            address: "tools.github.repos.list",
            name: "repos.list",
            integration: "github",
            description: "List repositories",
          },
        ]);
        const { store: store2, upserted: upserted2, deleted: deleted2 } = makeStore();
        const result2 = yield* reconcileToolCatalog({
          namespace,
          executor: executor2,
          embedder: fakeEmbedder,
          store: store2,
          chunker,
          fingerprints,
          owner,
        });

        expect(result2.reembedded).toBe(1);
        expect(result2.unchanged).toBe(1);
        // Old chunk ids for repos.get must have been deleted.
        for (const id of oldGetChunkIds) {
          expect(deleted2).toContain(id);
        }
        // Only repos.get chunks were re-upserted.
        for (const v of upserted2) {
          expect(v.metadata?.["path"]).toBe("github.repos.get");
        }
      }),
  );

  it.effect("a tool removed from the live list is swept: vector chunks + fingerprint deleted", () =>
    Effect.gen(function* () {
      const executor1 = makeExecutor([
        {
          address: "tools.github.repos.get",
          name: "repos.get",
          integration: "github",
          description: "Get a repository",
        },
        {
          address: "tools.github.repos.delete",
          name: "repos.delete",
          integration: "github",
          description: "Delete a repository",
        },
      ]);

      // First run — both tools indexed.
      const fingerprints = makeFingerprints();
      const { store: store1 } = makeStore();
      yield* reconcileToolCatalog({
        namespace,
        executor: executor1,
        embedder: fakeEmbedder,
        store: store1,
        chunker,
        fingerprints,
        owner,
      });

      // Second run — repos.delete is no longer in the catalog.
      const executor2 = makeExecutor([
        {
          address: "tools.github.repos.get",
          name: "repos.get",
          integration: "github",
          description: "Get a repository",
        },
      ]);
      const { store: store2, deleted: deleted2 } = makeStore();
      const result2 = yield* reconcileToolCatalog({
        namespace,
        executor: executor2,
        embedder: fakeEmbedder,
        store: store2,
        chunker,
        fingerprints,
        owner,
      });

      expect(result2.total).toBe(1);
      expect(result2.unchanged).toBe(1);
      expect(result2.removed).toBe(1);
      // repos.delete's vector chunks are swept (repos.get is unchanged, so it
      // contributes no deletions); its fingerprint row is removed.
      expect(deleted2.length).toBeGreaterThan(0);
      const remaining = yield* fingerprints.list();
      expect(remaining.map((e) => e.key)).toEqual(["github.repos.get"]);
    }),
  );

  it.effect(
    "populates the lexical store with every live tool, keyed by namespace-prefixed id",
    () =>
      Effect.gen(function* () {
        const fingerprints = makeFingerprints();
        const tools = [
          {
            address: "tools.github.repos.get",
            name: "repos.get",
            integration: "github",
            description: "Get a repository",
          },
          {
            address: "tools.calendar.events.create",
            name: "events.create",
            integration: "calendar",
            description: "Create a calendar event",
          },
        ];

        const lexical = makeFakeLexical();
        yield* reconcileToolCatalog({
          namespace,
          executor: makeExecutor(tools),
          embedder: fakeEmbedder,
          store: makeStore().store,
          chunker,
          fingerprints,
          owner,
          lexicalStore: lexical.store,
        });

        // One lexical doc per tool, id namespace-prefixed so paths can't collide
        // across namespaces in a shared store.
        expect(lexical.upserted.map((d) => d.id).sort()).toEqual([
          `${namespace}:calendar.events.create`,
          `${namespace}:github.repos.get`,
        ]);
        const repo = lexical.upserted.find((d) => d.id === `${namespace}:github.repos.get`);
        expect(repo?.path).toBe("github.repos.get");
        expect(repo?.integration).toBe("github");
        expect(repo?.namespace).toBe(namespace);
        expect((repo?.lexicalText ?? "").length).toBeGreaterThan(0);

        // A SECOND reindex with identical tools re-embeds nothing (fingerprints
        // match) yet still fully populates the lexical store — so attaching a
        // lexical store to an already-indexed deployment is not silently empty.
        const lexical2 = makeFakeLexical();
        const result2 = yield* reconcileToolCatalog({
          namespace,
          executor: makeExecutor(tools),
          embedder: fakeEmbedder,
          store: makeStore().store,
          chunker,
          fingerprints,
          owner,
          lexicalStore: lexical2.store,
        });
        expect(result2.reembedded).toBe(0);
        expect(result2.unchanged).toBe(2);
        expect(lexical2.upserted).toHaveLength(2);
      }),
  );
});

describe("reconcileToolCatalogPage", () => {
  it.effect("pages through the catalog one slice at a time, advancing the cursor", () =>
    Effect.gen(function* () {
      const executor = makeExecutor([
        { address: "tools.a.one", name: "one", integration: "a", description: "1" },
        { address: "tools.a.two", name: "two", integration: "a", description: "2" },
        { address: "tools.a.three", name: "three", integration: "a", description: "3" },
      ]);
      const fingerprints = makeFingerprints();
      const { store } = makeStore();
      const base = {
        namespace,
        executor,
        embedder: fakeEmbedder,
        store,
        chunker,
        fingerprints,
        owner,
        pageSize: 1,
      };

      const p0 = yield* reconcileToolCatalogPage({ ...base, cursor: 0 });
      expect(p0.total).toBe(3);
      expect(p0.processed).toBe(1);
      expect(p0.reembedded).toBe(1);
      expect(p0.nextCursor).toBe(1);

      const p1 = yield* reconcileToolCatalogPage({ ...base, cursor: 1 });
      expect(p1.processed).toBe(1);
      expect(p1.nextCursor).toBe(2);

      const p2 = yield* reconcileToolCatalogPage({ ...base, cursor: 2 });
      expect(p2.processed).toBe(1);
      expect(p2.nextCursor).toBe(null);

      // Every tool now has a fingerprint row (full coverage across pages).
      const rows = yield* fingerprints.list();
      expect(rows.length).toBe(3);
    }),
  );

  it.effect("a cursor past the end is an empty, terminal page", () =>
    Effect.gen(function* () {
      const executor = makeExecutor([
        { address: "tools.a.one", name: "one", integration: "a", description: "1" },
      ]);
      const page = yield* reconcileToolCatalogPage({
        namespace,
        executor,
        embedder: fakeEmbedder,
        store: makeStore().store,
        chunker,
        fingerprints: makeFingerprints(),
        owner,
        cursor: 5,
      });
      expect(page.total).toBe(1);
      expect(page.processed).toBe(0);
      expect(page.nextCursor).toBe(null);
    }),
  );
});

describe("sweepRemoved", () => {
  it.effect("deletes vector chunks + fingerprint for tools no longer in the catalog", () =>
    Effect.gen(function* () {
      const fingerprints = makeFingerprints(
        new Map([
          [
            "a.gone",
            { path: "a.gone", integration: "a", fingerprint: "x", chunkIds: ["a.gone#0"] },
          ],
          [
            "a.live",
            { path: "a.live", integration: "a", fingerprint: "y", chunkIds: ["a.live#0"] },
          ],
        ]),
      );
      const { store, deleted } = makeStore();
      const executor = makeExecutor([
        { address: "tools.a.live", name: "live", integration: "a", description: "" },
      ]);

      const result = yield* sweepRemoved({ namespace, executor, store, fingerprints, owner });

      expect(result.removed).toBe(1);
      expect(deleted).toContain("a.gone#0");
      expect(deleted).not.toContain("a.live#0");
      const rows = yield* fingerprints.list();
      expect(rows.map((e) => e.key)).toEqual(["a.live"]);
    }),
  );

  it.effect("an empty live catalog is a no-op (never wipes the index)", () =>
    Effect.gen(function* () {
      const fingerprints = makeFingerprints(
        new Map([
          ["a.x", { path: "a.x", integration: "a", fingerprint: "x", chunkIds: ["a.x#0"] }],
        ]),
      );
      const { store, deleted } = makeStore();

      const result = yield* sweepRemoved({
        namespace,
        executor: makeExecutor([]),
        store,
        fingerprints,
        owner,
      });

      expect(result.removed).toBe(0);
      expect(deleted).toHaveLength(0);
      const rows = yield* fingerprints.list();
      expect(rows.length).toBe(1);
    }),
  );
});
