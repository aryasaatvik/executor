import { SqlClient } from "@effect/sql"
import * as Effect from "effect/Effect"

export const hasVecTable = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const tables = yield* sql.unsafe<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='vec_catalog_tool'`,
    )
    return tables.length > 0
  })

/**
 * Create the vec_catalog_tool virtual table.
 * Dimensions are dynamic based on the configured embedder.
 *
 * IMPORTANT: This uses raw SQL because Drizzle doesn't support virtual tables.
 * The sqlite-vec extension must be loaded before calling this.
 */
export const setupVecTable = (dimensions: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_catalog_tool USING vec0(
        tool_id text primary key,
        embedding float[${dimensions}] distance_metric=cosine,
        source_key text,
        namespace text
      )`,
    )
  })

/**
 * Check the dimensions of the existing vec_catalog_tool table.
 * Returns null if the table doesn't exist, or the number of dimensions.
 *
 * Used to detect dimension mismatches when the embedder config changes.
 */
export const getVecTableDimensions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  if (!(yield* hasVecTable())) return null

  // Introspect the embedding column dimensions via table_info
  // vec0 tables report column info through pragma
  try {
    const info = yield* sql.unsafe<{ name: string; type: string }>(
      `PRAGMA table_info(vec_catalog_tool)`,
    )
    const embeddingCol = info.find((col) => col.name === "embedding")
    if (!embeddingCol) return null

    // Type looks like "float[768]" — extract the number
    const match = embeddingCol.type.match(/\[(\d+)\]/)
    return match ? parseInt(match[1], 10) : null
  } catch {
    return null
  }
})

/**
 * Drop the vec_catalog_tool table (used when dimensions change).
 */
export const dropVecTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`DROP TABLE IF EXISTS vec_catalog_tool`)
})

/**
 * Search for similar tools using vector KNN.
 *
 * CRITICAL: Never JOIN with vec0 tables (causes hangs in sqlite-vec).
 * Always do two-step: 1) fetch IDs from vec, 2) join metadata separately.
 */
export const searchVec = (input: {
  queryEmbedding: number[]
  limit: number
  sourceFilter?: string
  namespaceFilter?: string
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const embedding = new Float32Array(input.queryEmbedding)
    const sourceClause = input.sourceFilter ? ` AND source_key = ?` : ``
    const namespaceClause = input.namespaceFilter ? ` AND namespace = ?` : ``
    const params: Array<Float32Array | number | string> = [
      embedding,
      input.limit * 2,
      ...(input.sourceFilter ? [input.sourceFilter] : []),
      ...(input.namespaceFilter ? [input.namespaceFilter] : []),
    ]

    // Step 1: Vector KNN query (no joins!)
    const vecResults = yield* sql.unsafe<{
      tool_id: string
      distance: number
    }>(
      `SELECT tool_id, distance FROM vec_catalog_tool
       WHERE embedding MATCH ? AND k = ?${sourceClause}${namespaceClause}`,
      params, // over-fetch for any remaining ranking/dropoff
    )

    // Convert cosine distance to similarity score
    return vecResults.map((row) => ({
      toolId: row.tool_id,
      score: 1 / (1 + row.distance), // distance -> similarity
    }))
  })

/**
 * Upsert a tool's embedding vector.
 *
 * vec0 doesn't support UPDATE well, so we delete-then-insert.
 */
export const upsertVecTool = (input: {
  toolId: string
  embedding: number[]
  sourceKey: string
  namespace: string
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const vec = new Float32Array(input.embedding)

    // Delete then insert (vec0 doesn't support UPDATE well)
    yield* sql.unsafe(`DELETE FROM vec_catalog_tool WHERE tool_id = ?`, [
      input.toolId,
    ])
    yield* sql.unsafe(
      `INSERT INTO vec_catalog_tool (tool_id, embedding, source_key, namespace) VALUES (?, ?, ?, ?)`,
      [input.toolId, vec, input.sourceKey, input.namespace],
    )
  })

/**
 * Remove all vectors for a source.
 */
export const removeVecSourceTools = (sourceKey: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (!(yield* hasVecTable())) return
    yield* sql.unsafe(`DELETE FROM vec_catalog_tool WHERE source_key = ?`, [
      sourceKey,
    ])
  })

/**
 * Remove embedding rows for a specific set of tool IDs.
 */
export const removeVecTools = (toolIds: readonly string[]) =>
  Effect.gen(function* () {
    if (toolIds.length === 0) return

    const sql = yield* SqlClient.SqlClient
    if (!(yield* hasVecTable())) return

    for (const toolId of toolIds) {
      yield* sql.unsafe(`DELETE FROM vec_catalog_tool WHERE tool_id = ?`, [toolId])
    }
  })
