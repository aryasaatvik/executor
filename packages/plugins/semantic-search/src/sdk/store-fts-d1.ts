import { Effect } from "effect";

import { SemanticSearchError } from "./errors";
import {
  FTS_COUNT_SQL,
  FTS_DELETE_BY_ID_SQL,
  FTS_INSERT_SQL,
  FTS_SCHEMA_STATEMENTS,
  FTS_SEARCH_SQL,
  type FtsDocumentInput,
  type FtsLexicalStore,
  type FtsSearchInput,
  type FtsSearchResult,
  normalizeFtsQuery,
} from "./store-fts";

// ---------------------------------------------------------------------------
// Minimal D1 binding types — declared locally so the package needs no
// `@cloudflare/workers-types` dependency. The shapes mirror the subset of
// the D1 API that this adapter uses.
// ---------------------------------------------------------------------------

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  all<T = unknown>(): Promise<{ readonly results: readonly T[] }>;
}

interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: readonly D1PreparedStatement[]): Promise<readonly unknown[]>;
}

// Re-export the interface so hosts can type their binding without importing
// from `@cloudflare/workers-types`.
export type { D1Database, D1PreparedStatement };

// ---------------------------------------------------------------------------
// Schema init — applied once per D1Database instance. DDL runs sequentially
// (not via batch). Tracked in a WeakSet of already-initialised bindings rather
// than a cached init Promise, so a transient init failure is NEVER cached: the
// next call retries instead of leaving the store permanently unrecoverable for
// the isolate's lifetime. The statements are `CREATE … IF NOT EXISTS`, so the
// rare concurrent first-call re-run is idempotent.
// ---------------------------------------------------------------------------

const initialized = new WeakSet<D1Database>();

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Creates an `FtsLexicalStore` backed by a Cloudflare D1 database.
 *
 * The D1 binding uses the same SQLite FTS5 schema as `makeFtsLexicalStore`
 * (better-sqlite3/bun:sqlite variant), so index data is fully interchangeable.
 * Schema DDL is applied lazily on first use, once per binding instance.
 */
export const makeD1FtsLexicalStore = (d1: D1Database): FtsLexicalStore => {
  const ensureSchema = Effect.suspend(() =>
    initialized.has(d1)
      ? Effect.void
      : Effect.tryPromise({
          try: async () => {
            for (const stmt of FTS_SCHEMA_STATEMENTS) {
              await d1.prepare(stmt).run();
            }
          },
          catch: (cause) =>
            new SemanticSearchError({ message: "D1 FTS5 schema init failed.", cause }),
        }).pipe(Effect.tap(() => Effect.sync(() => initialized.add(d1)))),
  );

  return {
    upsert: (docs: readonly FtsDocumentInput[]) =>
      docs.length === 0
        ? Effect.void
        : ensureSchema.pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () => {
                  const stmts: D1PreparedStatement[] = [];
                  for (const doc of docs) {
                    stmts.push(d1.prepare(FTS_DELETE_BY_ID_SQL).bind(doc.id));
                    stmts.push(
                      d1
                        .prepare(FTS_INSERT_SQL)
                        .bind(
                          doc.id,
                          doc.namespace,
                          doc.path,
                          doc.name,
                          doc.description,
                          doc.integration,
                          doc.lexicalText,
                        ),
                    );
                  }
                  await d1.batch(stmts);
                },
                catch: (cause) =>
                  new SemanticSearchError({ message: "D1 FTS5 upsert failed.", cause }),
              }),
            ),
            Effect.asVoid,
          ),

    deleteByIds: (ids: readonly string[]) =>
      ids.length === 0
        ? Effect.void
        : ensureSchema.pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: async () => {
                  await d1.batch(ids.map((id) => d1.prepare(FTS_DELETE_BY_ID_SQL).bind(id)));
                },
                catch: (cause) =>
                  new SemanticSearchError({ message: "D1 FTS5 deleteByIds failed.", cause }),
              }),
            ),
            Effect.asVoid,
          ),

    search: ({ query, namespace, topK }: FtsSearchInput) =>
      ensureSchema.pipe(
        Effect.flatMap(() =>
          Effect.tryPromise({
            try: async () => {
              const ftsQuery = normalizeFtsQuery(query);
              if (ftsQuery === null) return [] as readonly FtsSearchResult[];

              const { results } = await d1
                .prepare(FTS_SEARCH_SQL)
                .bind(ftsQuery, namespace, topK)
                .all<{
                  readonly path: string;
                  readonly name: string;
                  readonly description: string;
                  readonly integration: string;
                  readonly score: number;
                }>();

              return results.map(
                (r): FtsSearchResult => ({
                  path: r.path,
                  name: r.name,
                  description: r.description,
                  integration: r.integration,
                  score: r.score,
                }),
              );
            },
            catch: (cause) => new SemanticSearchError({ message: "D1 FTS5 search failed.", cause }),
          }),
        ),
      ),

    count: (namespace: string) =>
      ensureSchema.pipe(
        Effect.flatMap(() =>
          Effect.tryPromise({
            try: async () => {
              const { results } = await d1
                .prepare(FTS_COUNT_SQL)
                .bind(namespace)
                .all<{ readonly n: number }>();
              return results[0]?.n ?? 0;
            },
            catch: (cause) => new SemanticSearchError({ message: "D1 FTS5 count failed.", cause }),
          }),
        ),
      ),
  };
};
