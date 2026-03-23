import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite"
import { SqlClient } from "@effect/sql"
import { eq, and, sql as drizzleSql } from "drizzle-orm"
import * as Context from "effect/Context"
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
import {
  VecService,
} from "./vec"
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
    .split(/[^\p{L}\p{N}_]+/u)
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
    sourceKey: string
    description: string | null
    interaction: string | null
    inputTypePreview: string | null
    outputTypePreview: string | null
    inputSchemaJson: unknown
    outputSchemaJson: unknown
    providerKind: string | null
  },
  includeSchemas: boolean,
): ToolDescriptor => {
  const contract: ToolContract = {
    ...(row.inputTypePreview != null
      ? { inputTypePreview: row.inputTypePreview }
      : {}),
    ...(row.outputTypePreview != null
      ? { outputTypePreview: row.outputTypePreview }
      : {}),
    ...(includeSchemas && row.inputSchemaJson != null
      ? { inputSchema: row.inputSchemaJson }
      : {}),
    ...(includeSchemas && row.outputSchemaJson != null
      ? { outputSchema: row.outputSchemaJson }
      : {}),
  }

  return {
    path: row.path as ToolPath,
    sourceKey: row.sourceKey,
    ...(row.description != null ? { description: row.description } : {}),
    interaction: (row.interaction ?? "auto") as "auto" | "required",
    ...(Object.keys(contract).length > 0 ? { contract } : {}),
    ...(row.providerKind != null ? { providerKind: row.providerKind } : {}),
  }
}

// ---------------------------------------------------------------------------
// Catalog columns used for descriptor queries
// ---------------------------------------------------------------------------

const descriptorColumns = {
  path: catalog_tool.path,
  sourceKey: catalog_tool.sourceKey,
  description: catalog_tool.description,
  interaction: catalog_tool.interaction,
  inputTypePreview: catalog_tool.inputTypePreview,
  outputTypePreview: catalog_tool.outputTypePreview,
  inputSchemaJson: catalog_tool.inputSchemaJson,
  outputSchemaJson: catalog_tool.outputSchemaJson,
  providerKind: catalog_tool.providerKind,
} as const

const lexicalScoreFromBm25 = (bm25Score: number): number => {
  const magnitude = Math.max(0, -bm25Score)
  return magnitude / (1 + magnitude)
}

const withSearchMode = (
  hits: readonly SearchHit[],
  searchMode: "fts" | "semantic" | "hybrid",
): readonly SearchHit[] =>
  Object.assign([...hits], { searchMode }) as readonly SearchHit[]

// ---------------------------------------------------------------------------
// SQLite-backed ToolCatalog
// ---------------------------------------------------------------------------

export class SqliteToolCatalogService extends Context.Tag(
  "#db/SqliteToolCatalogService",
)<SqliteToolCatalogService, ToolCatalog>() {}

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
const makeSqliteToolCatalog: (embedder?: Embedder) => Effect.Effect<
  ToolCatalog,
  never,
  SqliteDrizzle | SqlClient.SqlClient | VecService
> = (embedder?: Embedder) => Effect.gen(function* () {
  // Capture the runtime layer so we can provide it to each method's Effect
  const sqlClient = yield* SqlClient.SqlClient
  const drizzleDb = yield* SqliteDrizzle
  const vec = yield* VecService

  // Build a layer that provides both services from the captured values
  const runtimeLayer = Layer.mergeAll(
    Layer.succeed(SqlClient.SqlClient, sqlClient),
    Layer.succeed(SqliteDrizzle, drizzleDb),
    Layer.succeed(VecService, vec),
  )

  /**
   * Helper: run an inner Effect that needs SqlClient + SqliteDrizzle
   * by providing the captured layer.
   */
  const run = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient | SqliteDrizzle | VecService>) =>
    Effect.provide(effect, runtimeLayer)

  return {
    // -----------------------------------------------------------------------
    // searchTools
    // -----------------------------------------------------------------------
    searchTools: ({ query, namespace, sourceKey, limit }) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const vec = yield* VecService

          // -----------------------------------------------------------------
          // Step 1: Always run FTS5 search
          // -----------------------------------------------------------------
          const trimmedQuery = query.trim()
          if (trimmedQuery.length === 0) {
            return withSearchMode([], "fts")
          }

          const ftsQuery = buildFtsQuery(trimmedQuery)

          const namespaceClause = namespace ? `AND t.namespace = ?` : ""
          const sourceKeyClause = sourceKey ? `AND t.source_key = ?` : ""
          const ftsLimit = embedder ? limit * 2 : limit
          const params: Array<string | number> = [
            ftsQuery,
            ...(namespace ? [namespace] : []),
            ...(sourceKey ? [sourceKey] : []),
            ftsLimit,
          ]

          const rows = ftsQuery.length === 0
            ? []
            : yield* sql.unsafe<{
                path: string
                raw_score: number
              }>(
                `SELECT t.path,
                        bm25(catalog_tool_fts, 10.0, 8.0, 2.0, 1.0) as raw_score
                 FROM catalog_tool_fts
                 JOIN catalog_tool t ON t.rowid = catalog_tool_fts.rowid
                 WHERE catalog_tool_fts MATCH ?
                   AND t.source_enabled = 1
                   AND t.source_status = 'connected'
                   ${namespaceClause}
                   ${sourceKeyClause}
                 ORDER BY raw_score ASC
                 LIMIT ?`,
                params,
              )

          const ftsResults: readonly SearchHit[] = rows.map((row) => ({
            path: row.path as ToolPath,
            score: lexicalScoreFromBm25(row.raw_score),
          }))

          // -----------------------------------------------------------------
          // Step 2: If no embedder, return FTS-only results
          // -----------------------------------------------------------------
          if (!embedder) return withSearchMode(ftsResults.slice(0, limit), "fts")

          // -----------------------------------------------------------------
          // Step 3: Strong signal skip — if FTS top score is dominant, skip vec
          // -----------------------------------------------------------------
          if (ftsResults.length > 0 && ftsResults[0].score >= 0.85) {
            const gap = ftsResults.length > 1
              ? ftsResults[0].score - ftsResults[1].score
              : ftsResults[0].score
            if (gap >= 0.15) return withSearchMode(ftsResults.slice(0, limit), "fts")
          }

          // -----------------------------------------------------------------
          // Step 4: Embed query and run vector search
          // -----------------------------------------------------------------
          const queryEmbedding = yield* Effect.tryPromise({
            try: () => embedder.embed(trimmedQuery, "query"),
            catch: (cause) =>
              cause instanceof Error ? cause : new Error(String(cause)),
          })

          if (!(yield* vec.hasVecTable())) {
            return withSearchMode(ftsResults.slice(0, limit), "fts")
          }

          const vecResults = yield* vec.searchVec({
            queryEmbedding,
            limit: limit * 2,
            ...(sourceKey ? { sourceFilter: sourceKey } : {}),
            ...(namespace ? { namespaceFilter: namespace } : {}),
          })

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

          return withSearchMode(
            hybridResults as readonly SearchHit[],
            ftsResults.length === 0 ? "semantic" : "hybrid",
          )
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

            const trimmedQuery = query.trim()
            if (trimmedQuery.length === 0) {
              return [] as readonly ToolDescriptor[]
            }

            const ftsQuery = buildFtsQuery(trimmedQuery)
            if (ftsQuery.length === 0) {
              return [] as readonly ToolDescriptor[]
            }

            const namespaceClause = namespace ? `AND t.namespace = ?` : ""
            const params: Array<string | number> = namespace
              ? [ftsQuery, namespace, limit]
              : [ftsQuery, limit]

          const rows = yield* sql.unsafe<{
            path: string
            sourceKey: string
            description: string | null
            interaction: string | null
            inputTypePreview: string | null
            outputTypePreview: string | null
            inputSchemaJson: string | null
            outputSchemaJson: string | null
            providerKind: string | null
          }>(
              `SELECT t.path AS path, t.source_key AS sourceKey,
                      t.description AS description, t.interaction AS interaction,
                      t.input_type_preview AS inputTypePreview,
                      t.output_type_preview AS outputTypePreview,
                      t.input_schema_json AS inputSchemaJson,
                      t.output_schema_json AS outputSchemaJson,
                      t.provider_kind AS providerKind
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
                  inputSchemaJson: row.inputSchemaJson
                    ? JSON.parse(row.inputSchemaJson)
                    : null,
                  outputSchemaJson: row.outputSchemaJson
                    ? JSON.parse(row.outputSchemaJson)
                    : null,
                },
                includeSchemas,
              ),
            ) as readonly ToolDescriptor[]
          }

          // No query — use Drizzle query builder
          const db = yield* SqliteDrizzle

          const conditions = [
            eq(catalog_tool.sourceEnabled, true),
            eq(catalog_tool.sourceStatus, "connected"),
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
              toolCount: drizzleSql<number>`COUNT(*)`.as("toolCount"),
            })
            .from(catalog_tool)
            .where(and(
              eq(catalog_tool.sourceEnabled, true),
              eq(catalog_tool.sourceStatus, "connected"),
            ))
            .groupBy(catalog_tool.namespace)
            .limit(limit)

          return rows.map((row) => ({
            namespace: row.namespace,
            toolCount: row.toolCount,
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
              eq(catalog_tool.sourceEnabled, true),
              eq(catalog_tool.sourceStatus, "connected"),
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

export const SqliteToolCatalogLive = (embedder?: Embedder) =>
  Layer.effect(SqliteToolCatalogService, makeSqliteToolCatalog(embedder))

export const createSqliteToolCatalog = makeSqliteToolCatalog
