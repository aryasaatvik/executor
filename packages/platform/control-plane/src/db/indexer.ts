import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite"
import { SqlClient } from "@effect/sql"
import { eq, and, inArray } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { catalog_tool } from "./schema"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Clean interface for tools to be indexed. Decoupled from the runtime
 * LoadedSourceCatalogTool type so the indexer has no dependency on the
 * catalog runtime.
 */
export interface ToolToIndex {
  toolId: string // full path like "github.issues.create"
  path: string
  sourceId: string
  sourceKey: string
  namespace: string
  title?: string
  description?: string
  inputSchemaJson?: unknown
  outputSchemaJson?: unknown
  inputTypePreview?: string
  outputTypePreview?: string
  interaction?: string
  providerKind?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the combined search_text field for FTS indexing.
 *
 * Format:
 * ```
 * path: github.issues.create
 * source: github
 * namespace: github.issues
 * title: Create Issue
 * description: Create a new issue in a GitHub repository
 * params: owner (string) repo (string) title (string) body (string)
 * ```
 */
export const buildSearchText = (tool: ToolToIndex): string => {
  const lines: string[] = []

  lines.push(`path: ${tool.path}`)
  lines.push(`source: ${tool.sourceKey}`)
  lines.push(`namespace: ${tool.namespace}`)

  if (tool.title) {
    lines.push(`title: ${tool.title}`)
  }

  if (tool.description) {
    lines.push(`description: ${tool.description}`)
  }

  const params = extractParams(tool.inputSchemaJson)
  if (params.length > 0) {
    lines.push(`params: ${params.join(" ")}`)
  }

  return lines.join("\n")
}

/**
 * Extract param names and types from a JSON Schema-like input schema.
 * Returns entries like `"owner (string)"`.
 */
const extractParams = (schema: unknown): string[] => {
  if (
    schema === null ||
    schema === undefined ||
    typeof schema !== "object"
  ) {
    return []
  }

  const obj = schema as Record<string, unknown>
  const properties = obj.properties
  if (
    properties === null ||
    properties === undefined ||
    typeof properties !== "object"
  ) {
    return []
  }

  const props = properties as Record<string, unknown>
  return Object.entries(props).map(([name, def]) => {
    const typeName =
      def !== null &&
      def !== undefined &&
      typeof def === "object" &&
      "type" in def &&
      typeof (def as Record<string, unknown>).type === "string"
        ? ` (${(def as Record<string, unknown>).type as string})`
        : ""
    return `${name}${typeName}`
  })
}

/**
 * Compute a SHA-256 content hash for a tool using Bun's native crypto.
 * The hash is derived from: path + description + input_schema + output_schema.
 */
const computeContentHash = (tool: ToolToIndex): string => {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(
    tool.path +
      (tool.description ?? "") +
      JSON.stringify(tool.inputSchemaJson) +
      JSON.stringify(tool.outputSchemaJson),
  )
  return hasher.digest("hex") as string
}

// ---------------------------------------------------------------------------
// Index source tools
// ---------------------------------------------------------------------------

/**
 * Index a source's tools into the catalog_tool table.
 *
 * - Computes content_hash per tool and skips unchanged rows.
 * - Upserts new/changed tools.
 * - Removes stale tools that are no longer present in the source.
 *
 * Runs inside a transaction for atomicity.
 */
export const indexSource = (input: {
  sourceId: string
  sourceKey: string
  tools: readonly ToolToIndex[]
}) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle
    const sql = yield* SqlClient.SqlClient

    yield* sql.withTransaction(
      Effect.gen(function* () {
        // Fetch existing tools for this source to compare hashes
        const existing = yield* db
          .select({
            tool_id: catalog_tool.tool_id,
            content_hash: catalog_tool.content_hash,
          })
          .from(catalog_tool)
          .where(eq(catalog_tool.source_id, input.sourceId))

        const existingHashMap = new Map(
          existing.map((row) => [row.tool_id, row.content_hash]),
        )

        const incomingToolIds = new Set<string>()

        for (const tool of input.tools) {
          const contentHash = computeContentHash(tool)
          const searchText = buildSearchText(tool)
          incomingToolIds.add(tool.toolId)

          const existingHash = existingHashMap.get(tool.toolId)

          if (existingHash === contentHash) {
            // Tool unchanged — skip
            continue
          }

          if (existingHash !== undefined) {
            // Tool exists but changed — update
            yield* db
              .update(catalog_tool)
              .set({
                path: tool.path,
                source_key: tool.sourceKey,
                namespace: tool.namespace,
                title: tool.title ?? null,
                description: tool.description ?? null,
                search_text: searchText,
                input_schema_json: tool.inputSchemaJson ?? null,
                output_schema_json: tool.outputSchemaJson ?? null,
                input_type_preview: tool.inputTypePreview ?? null,
                output_type_preview: tool.outputTypePreview ?? null,
                interaction: tool.interaction ?? "auto",
                provider_kind: tool.providerKind ?? null,
                content_hash: contentHash,
                source_enabled: true,
                source_status: "connected",
              })
              .where(eq(catalog_tool.tool_id, tool.toolId))
          } else {
            // New tool — insert
            yield* db.insert(catalog_tool).values({
              tool_id: tool.toolId,
              path: tool.path,
              source_id: input.sourceId,
              source_key: tool.sourceKey,
              namespace: tool.namespace,
              title: tool.title ?? null,
              description: tool.description ?? null,
              search_text: searchText,
              input_schema_json: tool.inputSchemaJson ?? null,
              output_schema_json: tool.outputSchemaJson ?? null,
              input_type_preview: tool.inputTypePreview ?? null,
              output_type_preview: tool.outputTypePreview ?? null,
              interaction: tool.interaction ?? "auto",
              provider_kind: tool.providerKind ?? null,
              content_hash: contentHash,
              source_enabled: true,
              source_status: "connected",
            })
          }
        }

        // Remove stale tools that no longer exist in the source
        const staleToolIds = existing
          .map((row) => row.tool_id)
          .filter((id) => !incomingToolIds.has(id))

        if (staleToolIds.length > 0) {
          yield* db
            .delete(catalog_tool)
            .where(
              and(
                eq(catalog_tool.source_id, input.sourceId),
                inArray(catalog_tool.tool_id, staleToolIds),
              ),
            )
        }
      }),
    )
  })

// ---------------------------------------------------------------------------
// Deactivate source tools
// ---------------------------------------------------------------------------

/**
 * Mark all tools for a source as disabled (source_enabled = false).
 * Used when a source disconnects but is not removed.
 */
export const deactivateSourceTools = (sourceId: string) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle

    yield* db
      .update(catalog_tool)
      .set({
        source_enabled: false,
        source_status: "disconnected",
      })
      .where(eq(catalog_tool.source_id, sourceId))
  })

// ---------------------------------------------------------------------------
// Remove source tools
// ---------------------------------------------------------------------------

/**
 * Delete all tools for a source from the catalog_tool table.
 * Used when a source is permanently removed.
 */
export const removeSourceTools = (sourceId: string) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle

    yield* db
      .delete(catalog_tool)
      .where(eq(catalog_tool.source_id, sourceId))
  })
