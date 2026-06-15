import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { Executor, Tool } from "@executor-js/sdk/core";

import type { ToolEmbedder } from "./embedder";
import { reindexToolCatalog } from "./indexer";
import { makeVectorizeToolDiscoveryProvider } from "./provider";
import type { VectorizeMatch, VectorizeStore, VectorizeVectorInput } from "./vectorize";

const fakeEmbedder: ToolEmbedder = {
  model: "test",
  dimensions: 3,
  embedDocuments: (texts) => Effect.succeed(texts.map(() => [0.1, 0.2, 0.3])),
  embedQuery: () => Effect.succeed([1, 0, 0]),
};

const makeQueryStore = (matches: readonly VectorizeMatch[]): VectorizeStore => ({
  query: () => Effect.succeed(matches),
  upsert: () => Effect.void,
  deleteByIds: () => Effect.void,
});

const match = (path: string, score: number): VectorizeMatch => ({
  id: `org#${path}`,
  score,
  metadata: { path, name: path, description: `desc ${path}`, integration: "github" },
});

// Minimal stubs — the indexer only calls `tools.list()` and reads a few Tool
// fields, so a full branded Tool/Executor is unnecessary for these unit tests.
const stubTool = (address: string, name: string, integration: string, description: string): Tool =>
  // oxlint-disable-next-line executor/no-double-cast -- test stub: the indexer reads only these Tool fields
  ({ address, name, integration, description }) as unknown as Tool;
const stubExecutor = (tools: readonly Tool[]): Executor =>
  // oxlint-disable-next-line executor/no-double-cast -- test stub: only tools.list() is exercised
  ({ tools: { list: () => Effect.succeed(tools) } }) as unknown as Executor;

describe("makeVectorizeToolDiscoveryProvider", () => {
  it.effect("maps Vectorize matches to ToolDiscoveryResult", () =>
    Effect.gen(function* () {
      const provider = makeVectorizeToolDiscoveryProvider({
        embedder: fakeEmbedder,
        store: makeQueryStore([match("repos.get", 0.9), match("repos.list", 0.8)]),
        namespace: "org",
      });
      const page = yield* provider.searchTools({
        executor: undefined as never,
        query: "get a repo",
        limit: 10,
        offset: 0,
      });
      expect(page.items).toHaveLength(2);
      expect(page.items[0]).toEqual({
        path: "repos.get",
        name: "repos.get",
        description: "desc repos.get",
        integration: "github",
        score: 0.9,
      });
      expect(page.total).toBe(2);
      expect(page.hasMore).toBe(false);
      expect(page.nextOffset).toBeNull();
    }),
  );

  it.effect("paginates within the returned matches", () =>
    Effect.gen(function* () {
      const provider = makeVectorizeToolDiscoveryProvider({
        embedder: fakeEmbedder,
        store: makeQueryStore([match("a", 0.9), match("b", 0.8), match("c", 0.7)]),
        namespace: "org",
      });
      const page = yield* provider.searchTools({
        executor: undefined as never,
        query: "x",
        limit: 1,
        offset: 1,
      });
      expect(page.items.map((item) => item.path)).toEqual(["b"]);
      expect(page.hasMore).toBe(true);
      expect(page.nextOffset).toBe(2);
    }),
  );

  it.effect("returns empty for a blank query (no embedding call)", () =>
    Effect.gen(function* () {
      const provider = makeVectorizeToolDiscoveryProvider({
        embedder: {
          ...fakeEmbedder,
          embedQuery: () => Effect.die("embedQuery must not be called for a blank query") as never,
        },
        store: makeQueryStore([match("a", 0.9)]),
        namespace: "org",
      });
      const page = yield* provider.searchTools({
        executor: undefined as never,
        query: "   ",
        limit: 10,
        offset: 0,
      });
      expect(page.items).toHaveLength(0);
      expect(page.total).toBe(0);
    }),
  );
});

describe("reindexToolCatalog", () => {
  it.effect("projects the catalog and upserts namespaced records", () =>
    Effect.gen(function* () {
      const upserts: VectorizeVectorInput[][] = [];
      const store: VectorizeStore = {
        query: () => Effect.succeed([]),
        upsert: (vectors) =>
          Effect.sync(() => {
            upserts.push([...vectors]);
          }),
        deleteByIds: () => Effect.void,
      };
      const tool = stubTool("tools.github.repos.get", "repos.get", "github", "Get a repository");
      const executor = stubExecutor([tool]);

      const result = yield* reindexToolCatalog({
        namespace: "org",
        executor,
        embedder: fakeEmbedder,
        store,
      });

      expect(result.indexedToolCount).toBe(1);
      expect(upserts).toHaveLength(1);
      const record = upserts[0]![0]!;
      expect(record.id).toBe("org#github.repos.get");
      expect(record.namespace).toBe("org");
      expect(record.values).toEqual([0.1, 0.2, 0.3]);
      expect(record.metadata).toMatchObject({
        path: "github.repos.get",
        integration: "github",
        name: "repos.get",
      });
    }),
  );

  it.effect("no-ops on an empty catalog", () =>
    Effect.gen(function* () {
      const store: VectorizeStore = {
        query: () => Effect.succeed([]),
        upsert: () => Effect.die("upsert must not be called for an empty catalog") as never,
        deleteByIds: () => Effect.void,
      };
      const executor = stubExecutor([]);
      const result = yield* reindexToolCatalog({
        namespace: "org",
        executor,
        embedder: fakeEmbedder,
        store,
      });
      expect(result.indexedToolCount).toBe(0);
    }),
  );
});
