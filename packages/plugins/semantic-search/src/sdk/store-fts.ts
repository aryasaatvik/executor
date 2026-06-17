import {
  ExecutionToolError,
  type PagedResult,
  type ToolDiscoveryProvider,
  type ToolDiscoveryResult,
} from "@executor-js/sdk/core";
import { Effect } from "effect";

import { SemanticSearchError } from "./errors";
import { matchesNamespace } from "./provider";

// ---------------------------------------------------------------------------
// FTS5 lexical store — a local, in-process, file-backed full-text search store
// using SQLite's built-in FTS5 module (no sqlite-vec needed).
//
// Schema:
//   `docs` table — id, namespace, path, name, description, integration, lexical_text
//   `docs_fts` FTS5 virtual table — path, integration, name, description, lexical_text
//   tokenize='porter unicode61' (same as Pi's search)
//
// BM25 weights (Pi reference parity):
//   path=12, integration=8, name=10, description=5, lexical_text=3
//
// Score convention: `-bm25(...)` so higher is better (BM25 is negative for matches).
//
// `better-sqlite3` is lazy dynamic imported (like store-sqlite-vec/store-zvec) so
// the Cloudflare bundle never pulls in the native addon.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Internal types — normalized interface that bridges better-sqlite3 and bun:sqlite
// ---------------------------------------------------------------------------

interface SqliteStatement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary
  run(...args: any[]): { readonly lastInsertRowid: bigint | number };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary
  get(...args: any[]): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary
  all(...args: any[]): unknown[];
}

/** Normalized DB handle — subset used by both better-sqlite3 and bun:sqlite. */
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/**
 * Minimal `bun:sqlite` Database shape we use — declared locally so the package
 * typechecks without `@types/bun`. Consumers (e.g. host-cloudflare) typecheck
 * this source transitively and don't carry bun types.
 */
interface BunSqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary
    run(...a: any[]): { readonly lastInsertRowid: bigint | number };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary
    get(...a: any[]): unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary
    all(...a: any[]): unknown[];
  };
  close(): void;
}

// ---------------------------------------------------------------------------
// Shared SQL constants — imported by D1 and other adapters so the schema and
// query strings stay in exactly one place.
// ---------------------------------------------------------------------------

/** Schema statements in dependency order: content table → FTS5 virtual table → 3 triggers. */
export const FTS_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS fts_docs (
      id          TEXT PRIMARY KEY,
      namespace   TEXT NOT NULL DEFAULT '',
      path        TEXT NOT NULL,
      name        TEXT NOT NULL,
      description TEXT NOT NULL,
      integration TEXT NOT NULL,
      lexical_text TEXT NOT NULL
    )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS fts_docs_fts USING fts5(
      path,
      integration,
      name,
      description,
      lexical_text,
      content='fts_docs',
      content_rowid='rowid',
      tokenize='porter unicode61'
    )`,
  `CREATE TRIGGER IF NOT EXISTS fts_docs_ai AFTER INSERT ON fts_docs BEGIN
      INSERT INTO fts_docs_fts(rowid, path, integration, name, description, lexical_text)
        VALUES (new.rowid, new.path, new.integration, new.name, new.description, new.lexical_text);
    END`,
  `CREATE TRIGGER IF NOT EXISTS fts_docs_ad AFTER DELETE ON fts_docs BEGIN
      INSERT INTO fts_docs_fts(fts_docs_fts, rowid, path, integration, name, description, lexical_text)
        VALUES ('delete', old.rowid, old.path, old.integration, old.name, old.description, old.lexical_text);
    END`,
  `CREATE TRIGGER IF NOT EXISTS fts_docs_au AFTER UPDATE ON fts_docs BEGIN
      INSERT INTO fts_docs_fts(fts_docs_fts, rowid, path, integration, name, description, lexical_text)
        VALUES ('delete', old.rowid, old.path, old.integration, old.name, old.description, old.lexical_text);
      INSERT INTO fts_docs_fts(rowid, path, integration, name, description, lexical_text)
        VALUES (new.rowid, new.path, new.integration, new.name, new.description, new.lexical_text);
    END`,
];

/** DELETE a single document by id. */
export const FTS_DELETE_BY_ID_SQL = "DELETE FROM fts_docs WHERE id = ?";

/** INSERT a document (delete-then-insert upsert pattern). */
export const FTS_INSERT_SQL = `INSERT INTO fts_docs (id, namespace, path, name, description, integration, lexical_text)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`;

/**
 * BM25 search query — weights: path=12, integration=8, name=10, description=5, lexical_text=3.
 * Binds: (ftsQuery TEXT, namespace TEXT, topK INTEGER).
 * Returns columns: path, name, description, integration, score (higher = better).
 */
export const FTS_SEARCH_SQL = `SELECT
                    d.path        AS path,
                    d.name        AS name,
                    d.description AS description,
                    d.integration AS integration,
                    0 - bm25(fts_docs_fts, 12.0, 8.0, 10.0, 5.0, 3.0) AS score
                  FROM fts_docs_fts
                  JOIN fts_docs d ON d.rowid = fts_docs_fts.rowid
                  WHERE fts_docs_fts MATCH ?
                    AND d.namespace = ?
                  ORDER BY score DESC
                  LIMIT ?`;

/** COUNT of indexed lexical documents in a namespace. Binds: (namespace TEXT). */
export const FTS_COUNT_SQL = "SELECT count(*) AS n FROM fts_docs WHERE namespace = ?";

// ---------------------------------------------------------------------------
// FTS query normalisation — mirrors Pi's `toFtsQuery`:
//   camelCase-split → lowercase → filter stop-words → `term* term* …`
// ---------------------------------------------------------------------------

export const normalizeFtsQuery = (query: string): string | null => {
  const terms = query
    // Split camelCase: "createSubscription" → "create Subscription"
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    // Treat punctuation / separators as word boundaries
    .replace(/[_./:-]+/g, " ")
    .toLowerCase()
    .trim()
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  return terms.length === 0 ? null : terms.map((t) => `${t}*`).join(" ");
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FtsDocumentInput {
  readonly id: string;
  readonly namespace: string;
  readonly path: string;
  readonly name: string;
  readonly description: string;
  readonly integration: string;
  /** Broad text for FTS: identifiers, schema snippets, etc. */
  readonly lexicalText: string;
}

export interface FtsSearchInput {
  readonly query: string;
  readonly namespace: string;
  readonly topK: number;
}

export interface FtsSearchResult {
  readonly path: string;
  readonly name: string;
  readonly description: string;
  readonly integration: string;
  /** -bm25 score; higher is better. */
  readonly score: number;
}

export interface FtsLexicalStore {
  readonly upsert: (docs: readonly FtsDocumentInput[]) => Effect.Effect<void, SemanticSearchError>;
  readonly deleteByIds: (ids: readonly string[]) => Effect.Effect<void, SemanticSearchError>;
  readonly search: (
    input: FtsSearchInput,
  ) => Effect.Effect<readonly FtsSearchResult[], SemanticSearchError>;
  /** Count of indexed lexical documents in `namespace` (operator status). */
  readonly count: (namespace: string) => Effect.Effect<number, SemanticSearchError>;
}

// ---------------------------------------------------------------------------
// Database open + schema init
// ---------------------------------------------------------------------------

const openDatabase = async (dbPath: string): Promise<SqliteDatabase> => {
  let db: SqliteDatabase;

  // `globalThis.Bun` rather than the ambient `Bun` global so the package doesn't
  // require `@types/bun` in consumers' typecheck.
  if ((globalThis as { Bun?: unknown }).Bun !== undefined) {
    // Bun runtime: use the built-in bun:sqlite (better-sqlite3 is not supported in Bun).
    // The specifier is computed (not a literal) so neither tsgo nor esbuild tries to
    // resolve the bun-only "bun:sqlite" builtin — it's absent under node, where the
    // tests bundle, and only ever reached when actually running on Bun.
    const bunSqliteSpecifier = ["bun", "sqlite"].join(":");
    const { Database } = (await import(/* @vite-ignore */ bunSqliteSpecifier)) as {
      Database: new (path: string) => BunSqliteDatabase;
    };
    const bunDb = new Database(dbPath);
    // bun:sqlite exposes pragma as exec.
    // Wrap to satisfy our normalized SqliteDatabase interface.
    db = {
      exec: (sql) => bunDb.exec(sql),
      prepare: (sql) => {
        const stmt = bunDb.prepare(sql);
        return {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary
          run: (...args: any[]) => stmt.run(...args),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary
          get: (...args: any[]) => stmt.get(...args),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary
          all: (...args: any[]) => stmt.all(...args) as any[],
        };
      },
      close: () => bunDb.close(),
    };
    bunDb.exec("PRAGMA journal_mode = WAL");
    bunDb.exec("PRAGMA foreign_keys = ON");
  } else {
    // Node.js runtime: use better-sqlite3 (lazy import keeps Cloudflare bundle clean).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary: default export shape differs across bundlers
    const BetterSqlite3Mod = await import("better-sqlite3");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary
    const DatabaseCtor = (BetterSqlite3Mod as any).default ?? BetterSqlite3Mod;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: better-sqlite3 throws synchronously on open
    const nodeDb = new DatabaseCtor(dbPath) as SqliteDatabase & {
      pragma(s: string): unknown;
    };
    nodeDb.pragma("journal_mode = WAL");
    nodeDb.pragma("foreign_keys = ON");
    db = nodeDb;
  }

  db.exec(FTS_SCHEMA_STATEMENTS.join(";\n") + ";");

  return db;
};

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export const makeFtsLexicalStore = (options: { readonly path: string }): FtsLexicalStore => {
  let cached: Promise<SqliteDatabase> | null = null;
  const getDb = Effect.tryPromise({
    try: () => (cached ??= openDatabase(options.path)),
    catch: (cause) =>
      new SemanticSearchError({
        message: `FTS5 store open/init failed at ${options.path}.`,
        cause,
      }),
  });

  return {
    upsert: (docs) =>
      docs.length === 0
        ? Effect.void
        : getDb.pipe(
            Effect.flatMap((db) =>
              Effect.try({
                try: () => {
                  const del = db.prepare(FTS_DELETE_BY_ID_SQL);
                  const ins = db.prepare(FTS_INSERT_SQL);
                  // Atomic batch: delete-then-insert fires FTS triggers per doc, so a
                  // mid-loop failure must not leave the FTS index partially erased.
                  db.exec("BEGIN");
                  let committed = false;
                  // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: roll the batch back on partial failure
                  try {
                    for (const doc of docs) {
                      // Delete-then-insert: the triggers handle FTS sync.
                      del.run(doc.id);
                      ins.run(
                        doc.id,
                        doc.namespace,
                        doc.path,
                        doc.name,
                        doc.description,
                        doc.integration,
                        doc.lexicalText,
                      );
                    }
                    db.exec("COMMIT");
                    committed = true;
                  } finally {
                    if (!committed) db.exec("ROLLBACK");
                  }
                },
                catch: (cause) =>
                  new SemanticSearchError({ message: "FTS5 upsert failed.", cause }),
              }),
            ),
            Effect.asVoid,
          ),

    deleteByIds: (ids) =>
      ids.length === 0
        ? Effect.void
        : getDb.pipe(
            Effect.flatMap((db) =>
              Effect.try({
                try: () => {
                  const del = db.prepare(FTS_DELETE_BY_ID_SQL);
                  for (const id of ids) {
                    del.run(id);
                  }
                },
                catch: (cause) =>
                  new SemanticSearchError({ message: "FTS5 deleteByIds failed.", cause }),
              }),
            ),
            Effect.asVoid,
          ),

    search: ({ query, namespace, topK }) =>
      getDb.pipe(
        Effect.flatMap((db) =>
          Effect.try({
            try: () => {
              const ftsQuery = normalizeFtsQuery(query);
              if (ftsQuery === null) return [] as readonly FtsSearchResult[];

              // BM25 weights: path=12, integration=8, name=10, description=5, lexical_text=3
              // `-bm25(...)` so higher = better.
              const rows = db
                .prepare(FTS_SEARCH_SQL)
                .all(ftsQuery, namespace, topK) as ReadonlyArray<{
                readonly path: string;
                readonly name: string;
                readonly description: string;
                readonly integration: string;
                readonly score: number;
              }>;

              return rows.map(
                (r): FtsSearchResult => ({
                  path: r.path,
                  name: r.name,
                  description: r.description,
                  integration: r.integration,
                  score: r.score,
                }),
              );
            },
            catch: (cause) => new SemanticSearchError({ message: "FTS5 search failed.", cause }),
          }),
        ),
      ),

    count: (namespace) =>
      getDb.pipe(
        Effect.flatMap((db) =>
          Effect.try({
            try: () => {
              const row = db.prepare(FTS_COUNT_SQL).get(namespace) as
                | { readonly n: number }
                | undefined;
              return row?.n ?? 0;
            },
            catch: (cause) => new SemanticSearchError({ message: "FTS5 count failed.", cause }),
          }),
        ),
      ),
  };
};

// ---------------------------------------------------------------------------
// Provider adapter
// ---------------------------------------------------------------------------

/**
 * Wraps an `FtsLexicalStore` as a `ToolDiscoveryProvider` so it can be passed
 * to `makeHybridToolDiscoveryProvider` as the `lexical` source.
 *
 * `storageNamespace` is the storage partition key under which all documents were
 * upserted (the `FtsDocumentInput.namespace` value used at index time).  It is
 * separate from `ToolDiscoveryInput.namespace`, which is an integration-prefix
 * text filter used by the vector provider and intentionally ignored here.
 */
export const makeFtsLexicalProvider = (
  store: FtsLexicalStore,
  storageNamespace: string,
): ToolDiscoveryProvider => ({
  searchTools: ({ query, namespace, limit, offset }) =>
    Effect.gen(function* () {
      if (query.trim().length === 0) {
        return {
          items: [],
          total: 0,
          hasMore: false,
          nextOffset: null,
        } satisfies PagedResult<ToolDiscoveryResult>;
      }

      // Over-fetch so pagination after dedup is correct.
      const topK = Math.max(limit + Math.max(offset, 0), 50);
      // store.search partitions by the storage-level namespace; ToolDiscoveryInput
      // .namespace is a separate integration-prefix filter applied to the results,
      // shared with the vector provider so hybrid search narrows both paths alike.
      const rows = yield* store.search({ query, namespace: storageNamespace, topK });

      const items: readonly ToolDiscoveryResult[] = rows
        .map((r) => ({
          path: r.path,
          name: r.name,
          description: r.description.length > 0 ? r.description : undefined,
          integration: r.integration,
          score: r.score,
        }))
        .filter((result) => matchesNamespace(result, namespace));

      const safeOffset = Math.max(offset, 0);
      const start = Math.min(safeOffset, items.length);
      const page = items.slice(start, start + limit);
      const hasMore = items.length > start + page.length;

      return {
        items: page,
        total: items.length,
        hasMore,
        nextOffset: hasMore ? start + page.length : null,
      } satisfies PagedResult<ToolDiscoveryResult>;
    }).pipe(
      Effect.mapError(
        (cause) => new ExecutionToolError({ message: "FTS lexical tool search failed.", cause }),
      ),
    ),
});
