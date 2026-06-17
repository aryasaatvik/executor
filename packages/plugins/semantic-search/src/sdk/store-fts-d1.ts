import { Effect } from "effect";

import { SemanticSearchError } from "./errors";
import {
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
// Schema init — run once per D1Database instance. DDL must be executed
// sequentially (not via batch) because each statement depends on the previous.
// ---------------------------------------------------------------------------

const schemaCache = new WeakMap<D1Database, Promise<void>>();

const ensureSchemaFor = (d1: D1Database): Promise<void> => {
  const cached = schemaCache.get(d1);
  if (cached !== undefined) return cached;

  const init = (async () => {
    for (const stmt of FTS_SCHEMA_STATEMENTS) {
      await d1.prepare(stmt).run();
    }
  })();

  schemaCache.set(d1, init);
  return init;
};

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Creates an `FtsLexicalStore` backed by a Cloudflare D1 database.
 *
 * The D1 binding uses the same SQLite FTS5 schema as `makeFtsLexicalStore`
 * (better-sqlite3/bun:sqlite variant), so index data is fully interchangeable.
 * Schema DDL is applied lazily on first use and cached per binding instance.
 */
export const makeD1FtsLexicalStore = (d1: D1Database): FtsLexicalStore => {
  const ensureSchema = Effect.tryPromise({
    try: () => ensureSchemaFor(d1),
    catch: (cause) => new SemanticSearchError({ message: "D1 FTS5 schema init failed.", cause }),
  });

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
  };
};
