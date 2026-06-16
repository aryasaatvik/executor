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
import { reconcileToolCatalog } from "./indexer";
import type { VectorizeStore, VectorizeVectorInput } from "./vectorize";

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

/** Build a fake VectorizeStore that records upserts and deletes. */
const makeStore = () => {
  const upserted: VectorizeVectorInput[] = [];
  const deleted: string[] = [];
  const store: VectorizeStore = {
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
      expect(result.removedSkipped).toBe(0);
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

  it.effect(
    "a tool removed from the live list increments removedSkipped and is NOT deleted from the store",
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
        expect(result2.removedSkipped).toBe(1);
        // repos.delete's chunk ids must NOT appear in the delete list.
        expect(deleted2).toHaveLength(0);
      }),
  );
});
