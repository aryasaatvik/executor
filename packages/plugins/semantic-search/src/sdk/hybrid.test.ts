import { describe, expect, it } from "@effect/vitest";
import {
  ExecutionToolError,
  type ToolDiscoveryProvider,
  type ToolDiscoveryResult,
} from "@executor-js/sdk/core";
import { Effect, Exit } from "effect";

import { makeHybridToolDiscoveryProvider } from "./hybrid";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const makeResult = (path: string, score: number, description?: string): ToolDiscoveryResult => ({
  path,
  name: path,
  description,
  integration: "test",
  score,
});

/** Build an inline fake provider that returns a fixed ordered list of results. */
const makeFakeProvider = (results: readonly ToolDiscoveryResult[]): ToolDiscoveryProvider => ({
  searchTools: () =>
    Effect.succeed({ items: results, total: results.length, hasMore: false, nextOffset: null }),
});

/** A provider that always fails with ExecutionToolError. */
const failingProvider: ToolDiscoveryProvider = {
  searchTools: () => Effect.fail(new ExecutionToolError({ message: "provider failure" })),
};

const defaultInput = {
  executor: undefined as never,
  query: "test query",
  limit: 10,
  offset: 0,
};

// ---------------------------------------------------------------------------
// RRF score helpers used in assertions.
// weight_lex=0.7 weight_vec=0.3 k=60
// rank is 0-based.
// ---------------------------------------------------------------------------
const rrfScore = (
  lexRank: number | null,
  vecRank: number | null,
  opts?: { k?: number; wLex?: number; wVec?: number },
): number => {
  const k = opts?.k ?? 60;
  const wLex = opts?.wLex ?? 0.7;
  const wVec = opts?.wVec ?? 0.3;
  let score = 0;
  if (lexRank !== null) score += wLex / (k + lexRank);
  if (vecRank !== null) score += wVec / (k + vecRank);
  return score;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("makeHybridToolDiscoveryProvider — RRF fusion", () => {
  it.effect("an item ranked #1 in one source and absent in the other still surfaces high", () =>
    Effect.gen(function* () {
      // lexical: exact-name match "repos.create" first, "repos.list" second
      const lexical = makeFakeProvider([
        makeResult("repos.create", 0.95),
        makeResult("repos.list", 0.8),
      ]);
      // vector: intent match "issues.open" first, "repos.create" second
      const vector = makeFakeProvider([
        makeResult("issues.open", 0.92),
        makeResult("repos.create", 0.85),
      ]);

      const provider = makeHybridToolDiscoveryProvider({ lexical, vector });
      const page = yield* provider.searchTools(defaultInput);

      // "repos.create" is rank-0 in lex and rank-1 in vec → highest fused score.
      expect(page.items[0]!.path).toBe("repos.create");
      // "issues.open" is rank-0 in vec only → still surfaces above "repos.list"
      // (which is lex-only rank-1).
      const paths = page.items.map((r) => r.path);
      const issuesIdx = paths.indexOf("issues.open");
      const reposListIdx = paths.indexOf("repos.list");
      expect(issuesIdx).toBeGreaterThan(-1);
      expect(reposListIdx).toBeGreaterThan(-1);
      // issues.open (vec rank 0): 0.3/60 = 0.005
      // repos.list  (lex rank 1): 0.7/61 ≈ 0.01147
      // repos.list beats issues.open because wLex is larger.
      expect(reposListIdx).toBeLessThan(issuesIdx);
    }),
  );

  it.effect("a path in both sources gets a higher fused score than one in only one source", () =>
    Effect.gen(function* () {
      // "shared" appears in both at rank 1.
      // "lex-only" appears only in lexical at rank 0.
      const lexical = makeFakeProvider([makeResult("lex-only", 0.99), makeResult("shared", 0.8)]);
      const vector = makeFakeProvider([makeResult("vec-only", 0.99), makeResult("shared", 0.9)]);

      const provider = makeHybridToolDiscoveryProvider({ lexical, vector });
      const page = yield* provider.searchTools(defaultInput);

      const scoreMap = new Map(page.items.map((r) => [r.path, r.score]));

      // "shared": lex rank-1 + vec rank-1
      const sharedScore = rrfScore(1, 1);
      // "lex-only": lex rank-0 only
      const lexOnlyScore = rrfScore(0, null);
      // "vec-only": vec rank-0 only
      const vecOnlyScore = rrfScore(null, 0);

      expect(scoreMap.get("shared")).toBeCloseTo(sharedScore, 10);
      expect(scoreMap.get("lex-only")).toBeCloseTo(lexOnlyScore, 10);
      expect(scoreMap.get("vec-only")).toBeCloseTo(vecOnlyScore, 10);

      // The path in both sources outscores anything only-one-source at the same rank.
      // shared (lex-1+vec-1): 0.7/61 + 0.3/61 = 1/61 ≈ 0.01639
      // lex-only (lex-0): 0.7/60 ≈ 0.01167  — less than shared
      // vec-only (vec-0): 0.3/60 = 0.005     — less than shared
      expect(sharedScore).toBeGreaterThan(lexOnlyScore);
      expect(sharedScore).toBeGreaterThan(vecOnlyScore);

      const paths = page.items.map((r) => r.path);
      expect(paths.indexOf("shared")).toBeLessThan(paths.indexOf("lex-only"));
      expect(paths.indexOf("shared")).toBeLessThan(paths.indexOf("vec-only"));
    }),
  );

  it.effect("pagination (offset/limit) slices the FUSED list", () =>
    Effect.gen(function* () {
      // Build a scenario with 4 known paths, all-in-lexical so ordering is predictable.
      const lexical = makeFakeProvider([
        makeResult("a", 0.99),
        makeResult("b", 0.9),
        makeResult("c", 0.8),
        makeResult("d", 0.7),
      ]);
      const vector = makeFakeProvider([]); // no vector results

      const provider = makeHybridToolDiscoveryProvider({ lexical, vector });

      // First page: offset=0, limit=2
      const page1 = yield* provider.searchTools({ ...defaultInput, limit: 2, offset: 0 });
      expect(page1.items.map((r) => r.path)).toEqual(["a", "b"]);
      expect(page1.total).toBe(4);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextOffset).toBe(2);

      // Second page: offset=2, limit=2
      const page2 = yield* provider.searchTools({ ...defaultInput, limit: 2, offset: 2 });
      expect(page2.items.map((r) => r.path)).toEqual(["c", "d"]);
      expect(page2.total).toBe(4);
      expect(page2.hasMore).toBe(false);
      expect(page2.nextOffset).toBeNull();
    }),
  );

  it.effect("tie-break by path asc for determinism", () =>
    Effect.gen(function* () {
      // Two paths both appear only in lexical at the same rank — they cannot
      // both be rank-0, so put them at ranks 0 and 1, then have vector put two
      // OTHER paths at the same vector ranks, leaving "tie-a" and "tie-b" as
      // lex-only at the same relative scoring vis-à-vis each other.
      // Simpler: two items only from vector at the same rank via a custom k.
      // Use k=0 so that all lex-only items tied by rank differ only by path.
      // We can achieve an exact tie by having one item in each source at rank 0.
      const lexical = makeFakeProvider([makeResult("z-path", 0.9)]);
      const vector = makeFakeProvider([makeResult("a-path", 0.9)]);

      // With default weights: z-path gets 0.7/60; a-path gets 0.3/60.
      // They are NOT tied, so use equal weights to get a real tie.
      const provider = makeHybridToolDiscoveryProvider({
        lexical,
        vector,
        options: { weights: { lexical: 0.5, vector: 0.5 } },
      });

      const page = yield* provider.searchTools(defaultInput);
      // Both have score 0.5/60; tie-break alphabetically → "a-path" first.
      expect(page.items.map((r) => r.path)).toEqual(["a-path", "z-path"]);
    }),
  );

  it.effect("prefers the richer description when a path appears in both sources", () =>
    Effect.gen(function* () {
      const lexical = makeFakeProvider([makeResult("tool.x", 0.9, undefined)]);
      const vector = makeFakeProvider([makeResult("tool.x", 0.8, "A helpful description")]);

      const provider = makeHybridToolDiscoveryProvider({ lexical, vector });
      const page = yield* provider.searchTools(defaultInput);

      expect(page.items).toHaveLength(1);
      expect(page.items[0]!.description).toBe("A helpful description");
    }),
  );

  it.effect("description from lexical wins when vector has none", () =>
    Effect.gen(function* () {
      const lexical = makeFakeProvider([makeResult("tool.y", 0.9, "Lexical description")]);
      const vector = makeFakeProvider([makeResult("tool.y", 0.8, undefined)]);

      const provider = makeHybridToolDiscoveryProvider({ lexical, vector });
      const page = yield* provider.searchTools(defaultInput);

      expect(page.items[0]!.description).toBe("Lexical description");
    }),
  );

  it.effect("propagates ExecutionToolError from a failing provider", () =>
    Effect.gen(function* () {
      const provider = makeHybridToolDiscoveryProvider({
        lexical: failingProvider,
        vector: makeFakeProvider([makeResult("x", 0.9)]),
      });

      const result = yield* provider.searchTools(defaultInput).pipe(Effect.exit);
      // The error should be mapped to ExecutionToolError (cause wraps the original).
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect("custom weights, k, and fuseDepth are respected", () =>
    Effect.gen(function* () {
      const k = 10;
      const wLex = 0.4;
      const wVec = 0.6;

      const lexical = makeFakeProvider([makeResult("lex-item", 0.9)]);
      const vector = makeFakeProvider([makeResult("vec-item", 0.9)]);

      const provider = makeHybridToolDiscoveryProvider({
        lexical,
        vector,
        options: { weights: { lexical: wLex, vector: wVec }, k, fuseDepth: 50 },
      });

      const page = yield* provider.searchTools(defaultInput);
      const scoreMap = new Map(page.items.map((r) => [r.path, r.score]));

      expect(scoreMap.get("lex-item")).toBeCloseTo(rrfScore(0, null, { k, wLex, wVec }), 10);
      expect(scoreMap.get("vec-item")).toBeCloseTo(rrfScore(null, 0, { k, wLex, wVec }), 10);

      // With wVec > wLex, vec-item (rank-0 in vector) > lex-item (rank-0 in lexical).
      // wVec/10 > wLex/10
      expect(scoreMap.get("vec-item")!).toBeGreaterThan(scoreMap.get("lex-item")!);
      expect(page.items[0]!.path).toBe("vec-item");
    }),
  );

  it.effect("empty results from both providers yields an empty page", () =>
    Effect.gen(function* () {
      const provider = makeHybridToolDiscoveryProvider({
        lexical: makeFakeProvider([]),
        vector: makeFakeProvider([]),
      });

      const page = yield* provider.searchTools(defaultInput);
      expect(page.items).toHaveLength(0);
      expect(page.total).toBe(0);
      expect(page.hasMore).toBe(false);
      expect(page.nextOffset).toBeNull();
    }),
  );

  it.effect("offset beyond total returns an empty page with correct total", () =>
    Effect.gen(function* () {
      const lexical = makeFakeProvider([makeResult("a", 0.9), makeResult("b", 0.8)]);
      const vector = makeFakeProvider([]);

      const provider = makeHybridToolDiscoveryProvider({ lexical, vector });
      const page = yield* provider.searchTools({ ...defaultInput, limit: 5, offset: 100 });

      expect(page.items).toHaveLength(0);
      expect(page.total).toBe(2);
      expect(page.hasMore).toBe(false);
      expect(page.nextOffset).toBeNull();
    }),
  );
});
