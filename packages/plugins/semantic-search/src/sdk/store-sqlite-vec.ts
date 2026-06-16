import { Effect } from "effect";

import { SemanticSearchError } from "./errors";
import type { VectorInput, VectorMatch, VectorStore } from "./store";

// ---------------------------------------------------------------------------
// sqlite-vec-backed VectorStore — a local, in-process, file-backed vector
// similarity store using SQLite + the sqlite-vec extension (L2/cosine KNN).
//
// Schema:
//   vec0 virtual table `embedding_vectors` — float[dimensions] embedding col
//   bridge table `vectors` — id, vector_rowid, namespace, metadata_json
//
// Two implementation notes:
//   - metadata is stored as JSON in `metadata_json`; namespace lives as its
//     own column so the post-filter join is cheap.
//   - sqlite-vec KNN score is L2 distance (lower = nearer); we convert to a
//     similarity via `1 / (1 + distance)` so the API matches Vectorize's
//     higher-is-better convention.
//   - `better-sqlite3` + `sqlite-vec` are loaded lazily via dynamic import so
//     the plugin's Cloudflare build never pulls in native Node addons.
// ---------------------------------------------------------------------------

export interface SqliteVecStoreOptions {
  /** Absolute path to the SQLite database file. Created if absent. */
  readonly path: string;
  readonly dimensions: number;
  /** Maximum number of results a single `query` can return. Default 200. */
  readonly maxTopK?: number;
}

// ---------------------------------------------------------------------------
// Internal types — typed just enough to satisfy the adapter without shipping
// full better-sqlite3 types as a runtime dep (they're devDependencies only).
// ---------------------------------------------------------------------------

interface SqliteStatement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary
  run(...args: any[]): { readonly lastInsertRowid: bigint | number };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary
  get(...args: any[]): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary
  all(...args: any[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary
  pragma(pragma: string): any;
  close(): void;
}

interface SqliteVec {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- native addon
  load(db: any): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** JSON-encode a numeric array for the MATCH param sqlite-vec expects. */
const vectorToSql = (vector: readonly number[]): string => JSON.stringify(Array.from(vector));

const openDatabase = async (options: SqliteVecStoreOptions): Promise<SqliteDatabase> => {
  // Dynamic imports keep native addons out of the Cloudflare bundle.
  const [BetterSqlite3Mod, sqliteVecMod] = await Promise.all([
    import("better-sqlite3"),
    import("sqlite-vec"),
  ]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary: default export shape differs across bundlers
  const DatabaseCtor = (BetterSqlite3Mod as any).default ?? BetterSqlite3Mod;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary: sqlite-vec ships no compatible TS types for this usage
  // oxlint-disable-next-line executor/no-double-cast -- adapter boundary: sqlite-vec ships no TS types compatible with this usage; intermediate `any` is the only escape hatch
  const sqliteVec = sqliteVecMod as any as SqliteVec;

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: better-sqlite3 throws synchronously
  const db: SqliteDatabase = new DatabaseCtor(options.path) as SqliteDatabase;

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  sqliteVec.load(db);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS embedding_vectors USING vec0(
      embedding float[${options.dimensions}]
    );

    CREATE TABLE IF NOT EXISTS vectors (
      id TEXT PRIMARY KEY,
      vector_rowid INTEGER NOT NULL UNIQUE,
      namespace TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
  `);

  return db;
};

// ---------------------------------------------------------------------------
// Upsert helpers — separated so they can be composed inside a transaction
// ---------------------------------------------------------------------------

const buildUpsertStatements = (db: SqliteDatabase) => {
  const rowForId = db.prepare("SELECT vector_rowid AS vectorRowid FROM vectors WHERE id = ?");
  const deleteVector = db.prepare("DELETE FROM embedding_vectors WHERE rowid = ?");
  const deleteBridge = db.prepare("DELETE FROM vectors WHERE id = ?");
  const insertVector = db.prepare("INSERT INTO embedding_vectors(embedding) VALUES (?)");
  const insertBridge = db.prepare(
    "INSERT INTO vectors (id, vector_rowid, namespace, metadata_json) VALUES (?, ?, ?, ?)",
  );
  return { rowForId, deleteVector, deleteBridge, insertVector, insertBridge };
};

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export const makeSqliteVecStore = (options: SqliteVecStoreOptions): VectorStore => {
  const resolvedMaxTopK = options.maxTopK ?? 200;
  let cached: Promise<SqliteDatabase> | null = null;
  const getDb = Effect.tryPromise({
    try: () => (cached ??= openDatabase(options)),
    catch: (cause) =>
      new SemanticSearchError({
        message: `sqlite-vec open/init failed at ${options.path}.`,
        cause,
      }),
  });

  return {
    maxTopK: resolvedMaxTopK,

    upsert: (vectors: readonly VectorInput[]) =>
      vectors.length === 0
        ? Effect.void
        : getDb.pipe(
            Effect.flatMap((db) =>
              Effect.try({
                try: () => {
                  const stmts = buildUpsertStatements(db);
                  // Atomic batch: each vector is delete+delete+insert+insert across two
                  // tables, so a mid-loop failure must not leave the index half-written.
                  db.exec("BEGIN");
                  let committed = false;
                  // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: roll the batch back on partial failure
                  try {
                    for (const v of vectors) {
                      // Delete existing row if present (vector + bridge).
                      const existing = stmts.rowForId.get(v.id) as
                        | { readonly vectorRowid?: unknown }
                        | undefined;
                      if (typeof existing?.vectorRowid === "number") {
                        stmts.deleteVector.run(existing.vectorRowid);
                      }
                      stmts.deleteBridge.run(v.id);

                      // Insert new vector and capture its rowid.
                      const result = stmts.insertVector.run(vectorToSql(v.values));
                      const vectorRowid = Number(result.lastInsertRowid);

                      // Insert bridge row.
                      stmts.insertBridge.run(
                        v.id,
                        vectorRowid,
                        v.namespace ?? "",
                        JSON.stringify(v.metadata ?? {}),
                      );
                    }
                    db.exec("COMMIT");
                    committed = true;
                  } finally {
                    if (!committed) db.exec("ROLLBACK");
                  }
                },
                catch: (cause) =>
                  new SemanticSearchError({ message: "sqlite-vec upsert failed.", cause }),
              }),
            ),
            Effect.asVoid,
          ),

    query: ({ vector, namespace, topK }) =>
      getDb.pipe(
        Effect.flatMap((db) =>
          Effect.try({
            try: () => {
              // Over-fetch so namespace post-filter still yields topK results.
              const fetchK = Math.max(topK * 4, resolvedMaxTopK);
              const rows = db
                .prepare(
                  `SELECT
                    b.id AS id,
                    b.namespace AS namespace,
                    b.metadata_json AS metadataJson,
                    v.distance AS distance
                  FROM embedding_vectors v
                  JOIN vectors b ON b.vector_rowid = v.rowid
                  WHERE v.embedding MATCH ?
                    AND k = ?
                  ORDER BY v.distance ASC`,
                )
                .all(vectorToSql(vector), fetchK) as ReadonlyArray<{
                readonly id: string;
                readonly namespace: string;
                readonly metadataJson: string;
                readonly distance: number;
              }>;

              const out: VectorMatch[] = [];
              for (const row of rows) {
                if (row.namespace !== namespace) continue;
                let metadata: Record<string, unknown> | undefined;
                // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: decoding stored metadataJson string
                try {
                  // oxlint-disable-next-line executor/no-json-parse -- adapter boundary: decoding stored metadataJson string
                  metadata = JSON.parse(row.metadataJson) as Record<string, unknown>;
                } catch {
                  metadata = undefined;
                }
                out.push({
                  id: row.id,
                  score: 1 / (1 + row.distance),
                  namespace: row.namespace,
                  metadata,
                });
                if (out.length >= topK) break;
              }
              return out as readonly VectorMatch[];
            },
            catch: (cause) =>
              new SemanticSearchError({ message: "sqlite-vec query failed.", cause }),
          }),
        ),
      ),

    deleteByIds: (ids: readonly string[]) =>
      ids.length === 0
        ? Effect.void
        : getDb.pipe(
            Effect.flatMap((db) =>
              Effect.try({
                try: () => {
                  const rowForId = db.prepare(
                    "SELECT vector_rowid AS vectorRowid FROM vectors WHERE id = ?",
                  );
                  const deleteVector = db.prepare("DELETE FROM embedding_vectors WHERE rowid = ?");
                  const deleteBridge = db.prepare("DELETE FROM vectors WHERE id = ?");
                  for (const id of ids) {
                    const existing = rowForId.get(id) as
                      | { readonly vectorRowid?: unknown }
                      | undefined;
                    if (typeof existing?.vectorRowid === "number") {
                      deleteVector.run(existing.vectorRowid);
                    }
                    deleteBridge.run(id);
                  }
                },
                catch: (cause) =>
                  new SemanticSearchError({ message: "sqlite-vec delete failed.", cause }),
              }),
            ),
            Effect.asVoid,
          ),
  };
};
