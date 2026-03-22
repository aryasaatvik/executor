import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite"
import { SqlClient } from "@effect/sql"
import { eq, and, inArray } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { catalog_tool, source } from "./schema"
import { removeVecTools } from "./vec"

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

export interface SourceToIndex {
  sourceId: string
  workspaceId: string
  name: string
  kind: string
  endpoint: string
  status: string
  enabled: boolean
  namespace: string | null
  createdAt: number
  updatedAt: number
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
 * The hash is derived from every field that can affect indexed metadata,
 * descriptors, or search text.
 */
const computeContentHash = (tool: ToolToIndex, searchText: string): string => {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(JSON.stringify({
    path: tool.path,
    sourceKey: tool.sourceKey,
    namespace: tool.namespace,
    title: tool.title ?? null,
    description: tool.description ?? null,
    searchText,
    inputSchemaJson: tool.inputSchemaJson ?? null,
    outputSchemaJson: tool.outputSchemaJson ?? null,
    inputTypePreview: tool.inputTypePreview ?? null,
    outputTypePreview: tool.outputTypePreview ?? null,
    interaction: tool.interaction ?? "auto",
    providerKind: tool.providerKind ?? null,
  }))
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
  source: SourceToIndex
  tools: readonly ToolToIndex[]
}) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle
    const sql = yield* SqlClient.SqlClient
    const changedTools: ToolToIndex[] = []

    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* db.insert(source).values({
          id: input.source.sourceId,
          workspace_id: input.source.workspaceId,
          name: input.source.name,
          kind: input.source.kind,
          endpoint: input.source.endpoint,
          status: input.source.status,
          enabled: input.source.enabled,
          namespace: input.source.namespace,
          time_created: input.source.createdAt,
          time_updated: input.source.updatedAt,
        }).onConflictDoUpdate({
          target: source.id,
          set: {
            workspace_id: input.source.workspaceId,
            name: input.source.name,
            kind: input.source.kind,
            endpoint: input.source.endpoint,
            status: input.source.status,
            enabled: input.source.enabled,
            namespace: input.source.namespace,
            time_updated: input.source.updatedAt,
          },
        })

        // Fetch existing tools for this source to compare hashes
        const existing = yield* db
          .select({
            tool_id: catalog_tool.tool_id,
            content_hash: catalog_tool.content_hash,
            source_enabled: catalog_tool.source_enabled,
            source_status: catalog_tool.source_status,
          })
          .from(catalog_tool)
          .where(eq(catalog_tool.source_id, input.sourceId))

        const existingByToolId = new Map(
          existing.map((row) => [row.tool_id, row]),
        )

        const incomingToolIds = new Set<string>()

        for (const tool of input.tools) {
          const searchText = buildSearchText(tool)
          const contentHash = computeContentHash(tool, searchText)
          incomingToolIds.add(tool.toolId)

          const existingRow = existingByToolId.get(tool.toolId)
          const existingHash = existingRow?.content_hash

          if (existingHash === contentHash) {
            const needsReactivation =
              existingRow?.source_enabled !== true
              || existingRow?.source_status !== "connected"

            if (needsReactivation) {
              yield* db
                .update(catalog_tool)
                .set({
                  source_enabled: true,
                  source_status: "connected",
                })
                .where(eq(catalog_tool.tool_id, tool.toolId))
            }
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
            changedTools.push(tool)
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
            changedTools.push(tool)
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
          yield* removeVecTools(staleToolIds)
        }
      }),
    )

    return {
      changedTools,
    } as const
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
