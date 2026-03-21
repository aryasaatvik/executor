import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite"
import { SqlClient } from "@effect/sql"
import { eq, and, sql as drizzleSql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { catalog_tool } from "./schema"
import type {
  ToolCatalog,
  ToolDescriptor,
  ToolNamespace,
  ToolPath,
  SearchHit,
  ToolContract,
} from "@executor/codemode-core"
import type { Embedder } from "./embedder/types"
import { searchVec } from "./vec"
import { reciprocalRankFusion } from "./rrf"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an FTS5 query string from a user query.
 *
 * Tokenizes the query, escapes double-quotes (the FTS5 quoting char),
 * wraps each token in quotes, and joins with spaces (implicit AND).
 */
const buildFtsQuery = (query: string): string =>
  query
    .toLowerCase()
    .split(/\W+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" ")

/**
 * Map a catalog_tool row to a ToolDescriptor.
 *
 * When `includeSchemas` is false the heavy input/output schema JSON
 * fields are omitted from the contract to keep responses lightweight.
 */
const rowToDescriptor = (
  row: {
    path: string
    source_key: string
    description: string | null
    interaction: string | null
    input_type_preview: string | null
    output_type_preview: string | null
    input_schema_json: unknown
    output_schema_json: unknown
    provider_kind: string | null
  },
  includeSchemas: boolean,
): ToolDescriptor => {
  const contract: ToolContract = {
    ...(row.input_type_preview != null
      ? { inputTypePreview: row.input_type_preview }
      : {}),
    ...(row.output_type_preview != null
      ? { outputTypePreview: row.output_type_preview }
      : {}),
    ...(includeSchemas && row.input_schema_json != null
      ? { inputSchema: row.input_schema_json }
      : {}),
    ...(includeSchemas && row.output_schema_json != null
      ? { outputSchema: row.output_schema_json }
      : {}),
  }

  return {
    path: row.path as ToolPath,
    sourceKey: row.source_key,
    ...(row.description != null ? { description: row.description } : {}),
    interaction: (row.interaction ?? "auto") as "auto" | "required",
    ...(Object.keys(contract).length > 0 ? { contract } : {}),
    ...(row.provider_kind != null ? { providerKind: row.provider_kind } : {}),
  }
}

// ---------------------------------------------------------------------------
// Catalog columns used for descriptor queries
// ---------------------------------------------------------------------------

const descriptorColumns = {
  path: catalog_tool.path,
  source_key: catalog_tool.source_key,
  description: catalog_tool.description,
  interaction: catalog_tool.interaction,
  input_type_preview: catalog_tool.input_type_preview,
  output_type_preview: catalog_tool.output_type_preview,
  input_schema_json: catalog_tool.input_schema_json,
  output_schema_json: catalog_tool.output_schema_json,
  provider_kind: catalog_tool.provider_kind,
} as const

// ---------------------------------------------------------------------------
// SQLite-backed ToolCatalog
// ---------------------------------------------------------------------------

/**
 * Create a `ToolCatalog` implementation backed by SQLite with FTS5.
 *
 * Returns an Effect that resolves `SqliteDrizzle` and `SqlClient` from
 * context, then builds a catalog whose methods provide those services
 * internally — so each catalog method returns `Effect<T, unknown, never>`,
 * satisfying the `ToolCatalog` interface.
 *
 * Usage:
 * ```ts
 * const catalog = yield* createSqliteToolCatalog.pipe(
 *   Effect.provide(makeDatabaseLive("search.db"))
 * )
 * ```
 */
export const createSqliteToolCatalog: (embedder?: Embedder) => Effect.Effect<
  ToolCatalog,
  never,
  SqliteDrizzle | SqlClient.SqlClient
> = (embedder?: Embedder) => Effect.gen(function* () {
  // Capture the runtime layer so we can provide it to each method's Effect
  const sqlClient = yield* SqlClient.SqlClient
  const drizzleDb = yield* SqliteDrizzle

  // Build a layer that provides both services from the captured values
  const runtimeLayer = Layer.mergeAll(
    Layer.succeed(SqlClient.SqlClient, sqlClient),
    Layer.succeed(SqliteDrizzle, drizzleDb),
  )

  /**
   * Helper: run an inner Effect that needs SqlClient + SqliteDrizzle
   * by providing the captured layer.
   */
  const run = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient | SqliteDrizzle>) =>
    Effect.provide(effect, runtimeLayer)

  return {
    // -----------------------------------------------------------------------
    // searchTools
    // -----------------------------------------------------------------------
    searchTools: ({ query, namespace, limit }) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          // -----------------------------------------------------------------
          // Step 1: Always run FTS5 search
          // -----------------------------------------------------------------
          const ftsQuery = buildFtsQuery(query)
          if (ftsQuery.length === 0) {
            return [] as readonly SearchHit[]
          }

          const namespaceClause = namespace ? `AND t.namespace = ?` : ""
          const ftsLimit = embedder ? limit * 2 : limit
          const params: Array<string | number> = namespace
            ? [ftsQuery, namespace, ftsLimit]
            : [ftsQuery, ftsLimit]

          const rows = yield* sql.unsafe<{
            path: string
            raw_score: number
          }>(
            `SELECT t.path,
                    abs(bm25(catalog_tool_fts, 10.0, 8.0, 2.0, 1.0)) as raw_score
             FROM catalog_tool_fts
             JOIN catalog_tool t ON t.rowid = catalog_tool_fts.rowid
             WHERE catalog_tool_fts MATCH ?
               AND t.source_enabled = 1
               AND t.source_status = 'connected'
               ${namespaceClause}
             ORDER BY raw_score DESC
             LIMIT ?`,
            params,
          )

          const ftsResults: readonly SearchHit[] = rows.map((row) => ({
            path: row.path as ToolPath,
            score: row.raw_score / (1 + row.raw_score),
          }))

          // -----------------------------------------------------------------
          // Step 2: If no embedder, return FTS-only results
          // -----------------------------------------------------------------
          if (!embedder) return ftsResults.slice(0, limit)

          // -----------------------------------------------------------------
          // Step 3: Strong signal skip — if FTS top score is dominant, skip vec
          // -----------------------------------------------------------------
          if (ftsResults.length > 0 && ftsResults[0].score >= 0.85) {
            const gap = ftsResults.length > 1
              ? ftsResults[0].score - ftsResults[1].score
              : ftsResults[0].score
            if (gap >= 0.15) return ftsResults.slice(0, limit)
          }

          // -----------------------------------------------------------------
          // Step 4: Embed query and run vector search
          // -----------------------------------------------------------------
          const queryEmbedding = yield* Effect.tryPromise(() =>
            embedder.embed(query, "query"),
          ).pipe(Effect.catchAll(() => Effect.succeed(null)))

          if (!queryEmbedding) return ftsResults.slice(0, limit) // embedding failed, FTS fallback

          const vecResults = yield* searchVec({
            queryEmbedding,
            limit: limit * 2,
          }).pipe(Effect.catchAll(() => Effect.succeed([] as { toolId: string; score: number }[])))

          // -----------------------------------------------------------------
          // Step 5: RRF fusion
          // -----------------------------------------------------------------
          const hybridResults = reciprocalRankFusion(
            [
              { results: ftsResults, weight: 1.5 },
              {
                results: vecResults.map((r) => ({
                  path: r.toolId as ToolPath,
                  score: r.score,
                })),
                weight: 1.0,
              },
            ],
            60,
            limit,
          )

          return hybridResults as readonly SearchHit[]
        }),
      ),

    // -----------------------------------------------------------------------
    // listTools
    // -----------------------------------------------------------------------
    listTools: ({ namespace, query, limit, includeSchemas = false }) =>
      run(
        Effect.gen(function* () {
          if (query) {
            const sql = yield* SqlClient.SqlClient

            const ftsQuery = buildFtsQuery(query)
            if (ftsQuery.length === 0) {
              return [] as readonly ToolDescriptor[]
            }

            const namespaceClause = namespace ? `AND t.namespace = ?` : ""
            const params: Array<string | number> = namespace
              ? [ftsQuery, namespace, limit]
              : [ftsQuery, limit]

            const rows = yield* sql.unsafe<{
              path: string
              source_key: string
              description: string | null
              interaction: string | null
              input_type_preview: string | null
              output_type_preview: string | null
              input_schema_json: string | null
              output_schema_json: string | null
              provider_kind: string | null
            }>(
              `SELECT t.path, t.source_key, t.description, t.interaction,
                      t.input_type_preview, t.output_type_preview,
                      t.input_schema_json, t.output_schema_json,
                      t.provider_kind
               FROM catalog_tool_fts
               JOIN catalog_tool t ON t.rowid = catalog_tool_fts.rowid
               WHERE catalog_tool_fts MATCH ?
                 AND t.source_enabled = 1
                 AND t.source_status = 'connected'
                 ${namespaceClause}
               ORDER BY bm25(catalog_tool_fts, 10.0, 8.0, 2.0, 1.0)
               LIMIT ?`,
              params,
            )

            return rows.map((row) =>
              rowToDescriptor(
                {
                  ...row,
                  input_schema_json: row.input_schema_json
                    ? JSON.parse(row.input_schema_json)
                    : null,
                  output_schema_json: row.output_schema_json
                    ? JSON.parse(row.output_schema_json)
                    : null,
                },
                includeSchemas,
              ),
            ) as readonly ToolDescriptor[]
          }

          // No query — use Drizzle query builder
          const db = yield* SqliteDrizzle

          const conditions = [
            eq(catalog_tool.source_enabled, true),
            eq(catalog_tool.source_status, "connected"),
          ]
          if (namespace) {
            conditions.push(eq(catalog_tool.namespace, namespace))
          }

          const rows = yield* db
            .select(descriptorColumns)
            .from(catalog_tool)
            .where(and(...conditions))
            .limit(limit)

          return rows.map((row) =>
            rowToDescriptor(row, includeSchemas),
          ) as readonly ToolDescriptor[]
        }),
      ),

    // -----------------------------------------------------------------------
    // listNamespaces
    // -----------------------------------------------------------------------
    listNamespaces: ({ limit }) =>
      run(
        Effect.gen(function* () {
          const db = yield* SqliteDrizzle

          const rows = yield* db
            .select({
              namespace: catalog_tool.namespace,
              tool_count: drizzleSql<number>`COUNT(*)`.as("tool_count"),
            })
            .from(catalog_tool)
            .where(eq(catalog_tool.source_enabled, true))
            .groupBy(catalog_tool.namespace)
            .limit(limit)

          return rows.map((row) => ({
            namespace: row.namespace,
            toolCount: row.tool_count,
          })) as readonly ToolNamespace[]
        }),
      ),

    // -----------------------------------------------------------------------
    // getToolByPath
    // -----------------------------------------------------------------------
    getToolByPath: ({ path, includeSchemas }) =>
      run(
        Effect.gen(function* () {
          const db = yield* SqliteDrizzle

          const rows = yield* db
            .select(descriptorColumns)
            .from(catalog_tool)
            .where(and(
              eq(catalog_tool.path, path),
              eq(catalog_tool.source_enabled, true),
              eq(catalog_tool.source_status, "connected"),
            ))
            .limit(1)

          if (rows.length === 0) {
            return null
          }

          return rowToDescriptor(rows[0], includeSchemas)
        }),
      ),
  } satisfies ToolCatalog
})
