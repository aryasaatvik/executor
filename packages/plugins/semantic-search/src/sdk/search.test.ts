import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { ToolEmbedder } from "./embedder";
import { makeVectorToolDiscoveryProvider } from "./provider";
import { makeVectorizeStore } from "./store-cloudflare";
import type { VectorizeIndex } from "./store-cloudflare";
import type { VectorMatch, VectorStore, VectorInput } from "./store";

const fakeEmbedder: ToolEmbedder = {
  model: "test",
  dimensions: 3,
  embedDocuments: (texts) => Effect.succeed(texts.map(() => [0.1, 0.2, 0.3])),
  embedQuery: () => Effect.succeed([1, 0, 0]),
};

// The fake store honours topK (slicing to it) so pagination is exercised against
// a realistic window — a store that ignored topK would mask hasMore bugs.
const makeQueryStore = (matches: readonly VectorMatch[]): VectorStore => ({
  maxTopK: 20,
  query: ({ topK }) => Effect.succeed(matches.slice(0, topK)),
  upsert: () => Effect.void,
  deleteByIds: () => Effect.void,
});

const matchIn = (path: string, integration: string, score: number): VectorMatch => ({
  id: `org#${path}`,
  score,
  metadata: { path, name: path, description: `desc ${path}`, integration },
});

const match = (path: string, score: number): VectorMatch => matchIn(path, "github", score);

describe("makeVectorToolDiscoveryProvider", () => {
  it.effect("maps Vectorize matches to ToolDiscoveryResult", () =>
    Effect.gen(function* () {
      const provider = makeVectorToolDiscoveryProvider({
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
      const provider = makeVectorToolDiscoveryProvider({
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

  it.effect("reports hasMore on a full first page", () =>
    Effect.gen(function* () {
      const provider = makeVectorToolDiscoveryProvider({
        embedder: fakeEmbedder,
        store: makeQueryStore([match("a", 0.9), match("b", 0.8), match("c", 0.7)]),
        namespace: "org",
      });
      const page = yield* provider.searchTools({
        executor: undefined as never,
        query: "x",
        limit: 2,
        offset: 0,
      });
      expect(page.items.map((item) => item.path)).toEqual(["a", "b"]);
      expect(page.hasMore).toBe(true);
      expect(page.nextOffset).toBe(2);
    }),
  );

  it.effect("narrows results to input.namespace (integration prefix)", () =>
    Effect.gen(function* () {
      const provider = makeVectorToolDiscoveryProvider({
        embedder: fakeEmbedder,
        store: makeQueryStore([
          matchIn("github.repos.get", "github", 0.9),
          matchIn("slack.chat.post", "slack", 0.8),
          matchIn("github.issues.list", "github", 0.7),
        ]),
        namespace: "org",
      });
      const page = yield* provider.searchTools({
        executor: undefined as never,
        query: "x",
        namespace: "github",
        limit: 10,
        offset: 0,
      });
      expect(page.items.every((item) => item.integration === "github")).toBe(true);
      expect(page.items.map((item) => item.path)).toEqual([
        "github.repos.get",
        "github.issues.list",
      ]);
    }),
  );

  it.effect("keeps hasMore correct when the namespace filter drops interspersed items", () =>
    Effect.gen(function* () {
      // Greptile scenario: a non-matching item sits where a tight probe would be.
      const provider = makeVectorToolDiscoveryProvider({
        embedder: fakeEmbedder,
        store: makeQueryStore([
          matchIn("github.a", "github", 0.9),
          matchIn("slack.b", "slack", 0.8),
          matchIn("github.c", "github", 0.7),
          matchIn("github.d", "github", 0.6),
        ]),
        namespace: "org",
      });
      const page = yield* provider.searchTools({
        executor: undefined as never,
        query: "x",
        namespace: "github",
        limit: 2,
        offset: 0,
      });
      expect(page.items.map((item) => item.path)).toEqual(["github.a", "github.c"]);
      expect(page.hasMore).toBe(true);
      expect(page.nextOffset).toBe(2);
    }),
  );

  it.effect("returns empty for a blank query (no embedding call)", () =>
    Effect.gen(function* () {
      const provider = makeVectorToolDiscoveryProvider({
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

  it.effect("dedupes multi-facet matches by path, keeping the best score", () =>
    Effect.gen(function* () {
      // The facet chunker indexes a tool as several chunks, so the same path can
      // come back more than once — the provider must collapse to the best score.
      const provider = makeVectorToolDiscoveryProvider({
        embedder: fakeEmbedder,
        store: makeQueryStore([
          match("repos.get", 0.6), // identity-facet chunk
          match("repos.list", 0.7),
          match("repos.get", 0.9), // a higher-scoring facet chunk of the same tool
        ]),
        namespace: "org",
      });
      const page = yield* provider.searchTools({
        executor: undefined as never,
        query: "x",
        limit: 10,
        offset: 0,
      });
      expect(page.items.map((item) => item.path)).toEqual(["repos.get", "repos.list"]);
      expect(page.items[0]!.score).toBe(0.9);
      expect(page.total).toBe(2);
    }),
  );
});

describe("makeVectorizeStore", () => {
  it.effect("chunks upserts under the Vectorize per-call cap", () =>
    Effect.gen(function* () {
      const batches: number[] = [];
      const index: VectorizeIndex = {
        query: () => Promise.resolve({ matches: [] }),
        upsert: (vectors) => {
          batches.push(vectors.length);
          return Promise.resolve({});
        },
        deleteByIds: () => Promise.resolve({}),
      };
      const store = makeVectorizeStore(index);
      const vectors: readonly VectorInput[] = Array.from({ length: 120 }, (_, i) => ({
        id: `v${i}`,
        values: [0, 0, 0],
      }));

      yield* store.upsert(vectors);

      // 120 records at batch size 50 -> [50, 50, 20]; never a single 120 call.
      expect(batches).toEqual([50, 50, 20]);
    }),
  );
});
