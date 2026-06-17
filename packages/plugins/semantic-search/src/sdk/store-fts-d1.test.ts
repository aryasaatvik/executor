import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { makeD1FtsLexicalStore, type D1Database, type D1PreparedStatement } from "./store-fts-d1";
import type { FtsDocumentInput } from "./store-fts";

// ---------------------------------------------------------------------------
// D1 shim backed by better-sqlite3
//
// Implements the minimal D1Database / D1PreparedStatement async API as a thin
// wrapper over an in-memory better-sqlite3 Database.  The shim lets us run the
// exact adapter code against real SQLite FTS5 without needing a real D1 binding.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary
type BetterSqliteDb = any;

const makeD1Shim = (db: BetterSqliteDb): D1Database => {
  const makeStmt = (sql: string, boundValues: readonly unknown[]): D1PreparedStatement => ({
    bind(...values: unknown[]): D1PreparedStatement {
      return makeStmt(sql, [...boundValues, ...values]);
    },
    run(): Promise<unknown> {
      return Promise.resolve(db.prepare(sql).run(...boundValues));
    },
    all<T = unknown>(): Promise<{ readonly results: readonly T[] }> {
      const results: readonly T[] = db.prepare(sql).all(...boundValues) as readonly T[];
      return Promise.resolve({ results });
    },
  });

  return {
    prepare(sql: string): D1PreparedStatement {
      return makeStmt(sql, []);
    },

    async batch(statements: readonly D1PreparedStatement[]): Promise<readonly unknown[]> {
      db.exec("BEGIN");
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: need rollback on batch failure
      try {
        const results: unknown[] = [];
        for (const stmt of statements) {
          results.push(await stmt.run());
        }
        db.exec("COMMIT");
        return results;
      } catch (err) {
        db.exec("ROLLBACK");
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: re-throw after rollback
        throw err;
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const doc = (
  id: string,
  integration: string,
  path: string,
  name: string,
  description: string,
  lexicalText: string,
  namespace = "default",
): FtsDocumentInput => ({
  id,
  namespace,
  integration,
  path,
  name,
  description,
  lexicalText,
});

// ---------------------------------------------------------------------------
// Helper: create a fresh in-memory D1-shimmed store per test
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary
const makeTestStore = async (): Promise<{
  store: ReturnType<typeof makeD1FtsLexicalStore>;
  db: any;
}> => {
  const BetterSqlite3Mod = await import("better-sqlite3");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary
  const DatabaseCtor = (BetterSqlite3Mod as any).default ?? BetterSqlite3Mod;
  const db = new DatabaseCtor(":memory:");
  const d1: D1Database = makeD1Shim(db);
  const store = makeD1FtsLexicalStore(d1);
  return { store, db };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("makeD1FtsLexicalStore", () => {
  it.effect("upserts and searches — github doc ranks for 'create repo'", () =>
    Effect.gen(function* () {
      const { store } = yield* Effect.promise(() => makeTestStore());

      yield* store.upsert([
        doc(
          "github:repos.create",
          "github",
          "github.repos.create",
          "Create a repository",
          "Creates a new GitHub repository for the authenticated user.",
          "github repos create repository owner name private",
        ),
        doc(
          "calendar:events.create",
          "calendar",
          "calendar.events.create",
          "Create a calendar event",
          "Creates a new event on the user's calendar.",
          "calendar events create event start end summary",
        ),
      ]);

      const results = yield* store.search({
        query: "create repo",
        namespace: "default",
        topK: 10,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.path).toBe("github.repos.create");
      expect(results[0]!.integration).toBe("github");
      expect(typeof results[0]!.score).toBe("number");
      expect(results[0]!.score).toBeGreaterThan(0);
    }),
  );

  it.effect("namespace partitioning — doc in namespace 'a' not returned for namespace 'b'", () =>
    Effect.gen(function* () {
      const { store } = yield* Effect.promise(() => makeTestStore());

      yield* store.upsert([
        doc(
          "org-a:repos.list",
          "github",
          "github.repos.list",
          "List repositories",
          "Lists repositories for a user.",
          "github repos list repository",
          "a",
        ),
        doc(
          "org-b:repos.create",
          "github",
          "github.repos.create",
          "Create a repository",
          "Creates a new GitHub repository.",
          "github repos create repository",
          "b",
        ),
      ]);

      const resultsA = yield* store.search({ query: "repos", namespace: "a", topK: 10 });
      const resultsB = yield* store.search({ query: "repos", namespace: "b", topK: 10 });

      expect(resultsA.map((r) => r.path)).toEqual(["github.repos.list"]);
      expect(resultsB.map((r) => r.path)).toEqual(["github.repos.create"]);
    }),
  );

  it.effect("deleteByIds — removes a doc; subsequent search omits it", () =>
    Effect.gen(function* () {
      const { store } = yield* Effect.promise(() => makeTestStore());

      yield* store.upsert([
        doc(
          "github:repos.create",
          "github",
          "github.repos.create",
          "Create a repository",
          "Creates a new GitHub repository.",
          "github repos create",
        ),
        doc(
          "github:repos.list",
          "github",
          "github.repos.list",
          "List repositories",
          "Lists repositories.",
          "github repos list",
        ),
      ]);

      yield* store.deleteByIds(["github:repos.create"]);

      const results = yield* store.search({ query: "repos", namespace: "default", topK: 10 });
      const paths = results.map((r) => r.path);

      expect(paths).not.toContain("github.repos.create");
      expect(paths).toContain("github.repos.list");
    }),
  );

  it.effect("prefix matching — query 'repo' matches 'repos'", () =>
    Effect.gen(function* () {
      const { store } = yield* Effect.promise(() => makeTestStore());

      yield* store.upsert([
        doc(
          "github:repos.get",
          "github",
          "github.repos.get",
          "Get a repository",
          "Returns information about a GitHub repository.",
          "github repos get repository",
        ),
      ]);

      const results = yield* store.search({ query: "repo", namespace: "default", topK: 10 });

      // prefix query 'repo*' must match 'repos' via FTS5 prefix matching
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.path).toBe("github.repos.get");
    }),
  );

  it.effect("empty upsert is a no-op and does not fail", () =>
    Effect.gen(function* () {
      const { store } = yield* Effect.promise(() => makeTestStore());
      yield* store.upsert([]);
      const results = yield* store.search({ query: "anything", namespace: "default", topK: 10 });
      expect(results).toHaveLength(0);
    }),
  );

  it.effect("empty deleteByIds is a no-op and does not fail", () =>
    Effect.gen(function* () {
      const { store } = yield* Effect.promise(() => makeTestStore());
      yield* store.deleteByIds([]);
    }),
  );

  it.effect("search with blank-ish query returns empty without error", () =>
    Effect.gen(function* () {
      const { store } = yield* Effect.promise(() => makeTestStore());
      yield* store.upsert([
        doc(
          "github:repos.get",
          "github",
          "github.repos.get",
          "Get a repository",
          "Returns information about a GitHub repository.",
          "github repos get",
        ),
      ]);
      // normalizeFtsQuery("") returns null → should short-circuit to []
      const results = yield* store.search({ query: "", namespace: "default", topK: 10 });
      expect(results).toHaveLength(0);
    }),
  );

  it.effect("upsert is idempotent — re-upsert same id replaces the doc", () =>
    Effect.gen(function* () {
      const { store } = yield* Effect.promise(() => makeTestStore());

      yield* store.upsert([
        doc(
          "github:repos.create",
          "github",
          "github.repos.create",
          "Create a repository",
          "Creates a new GitHub repository.",
          "github repos create repository",
        ),
      ]);
      // Re-upsert with updated description
      yield* store.upsert([
        doc(
          "github:repos.create",
          "github",
          "github.repos.create",
          "Create a repository (updated)",
          "Updated description.",
          "github repos create repository updated",
        ),
      ]);

      const results = yield* store.search({ query: "create repo", namespace: "default", topK: 10 });
      // Should still be exactly one result (not two)
      const paths = results.map((r) => r.path);
      expect(paths.filter((p) => p === "github.repos.create")).toHaveLength(1);
    }),
  );

  it.effect("count — reports indexed docs per namespace", () =>
    Effect.gen(function* () {
      const { store } = yield* Effect.promise(() => makeTestStore());

      yield* store.upsert([
        doc(
          "default:repos.get",
          "github",
          "github.repos.get",
          "Get a repository",
          "Returns a repository.",
          "github repos get",
        ),
        doc(
          "default:repos.list",
          "github",
          "github.repos.list",
          "List repositories",
          "Lists repositories.",
          "github repos list",
        ),
        doc(
          "other:events.create",
          "calendar",
          "calendar.events.create",
          "Create an event",
          "Creates an event.",
          "calendar events create",
          "other",
        ),
      ]);

      expect(yield* store.count("default")).toBe(2);
      expect(yield* store.count("other")).toBe(1);
      expect(yield* store.count("empty")).toBe(0);
    }),
  );

  it.effect("retries schema init after a transient failure (the rejection is not cached)", () =>
    Effect.gen(function* () {
      const BetterSqlite3Mod = yield* Effect.promise(() => import("better-sqlite3"));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary
      const DatabaseCtor = (BetterSqlite3Mod as any).default ?? BetterSqlite3Mod;
      const db = new DatabaseCtor(":memory:");

      // A D1 shim whose very first run() rejects (a transient init failure),
      // then behaves normally — exercises the "don't cache the rejection" path.
      const base = makeD1Shim(db);
      let injectedFailure = false;
      const flaky: D1Database = {
        prepare(sql: string): D1PreparedStatement {
          const stmt = base.prepare(sql);
          return {
            bind: stmt.bind,
            all: stmt.all,
            run(): Promise<unknown> {
              if (!injectedFailure) {
                injectedFailure = true;
                // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- test shim: simulate a transient D1 runtime failure
                return Promise.reject(new Error("transient D1 failure"));
              }
              return stmt.run();
            },
          };
        },
        batch: base.batch,
      };
      const store = makeD1FtsLexicalStore(flaky);

      // First use fails because schema init hits the injected failure.
      const firstExit = yield* Effect.exit(
        store.search({ query: "repo", namespace: "default", topK: 10 }),
      );
      expect(Exit.isFailure(firstExit)).toBe(true);

      // A subsequent use retries schema init (not cached as failed) and works.
      yield* store.upsert([
        doc(
          "github:repos.get",
          "github",
          "github.repos.get",
          "Get a repository",
          "Returns a repository.",
          "github repos get repository",
        ),
      ]);
      const results = yield* store.search({ query: "repo", namespace: "default", topK: 10 });
      expect(results.map((r) => r.path)).toContain("github.repos.get");
    }),
  );
});
