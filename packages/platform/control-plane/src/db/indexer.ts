import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite"
import { SqlClient } from "@effect/sql"
import { eq, and, inArray } from "drizzle-orm"
import * as Effect from "effect/Effect"
import type { SourceId, SourceKind, SourceStatus, WorkspaceId } from "#schema"
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
  sourceId: SourceId
  sourceKey: string
  namespace: string
  searchText?: string
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
  sourceId: SourceId
  workspaceId: WorkspaceId
  name: string
  kind: SourceKind
  endpoint: string
  status: SourceStatus
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

  if (tool.searchText) {
    lines.push(`search: ${tool.searchText}`)
  }

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
  sourceId: SourceId
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
        const sourceRow = {
          id: input.source.sourceId,
          workspaceId: input.source.workspaceId,
          name: input.source.name,
          kind: input.source.kind,
          endpoint: input.source.endpoint,
          status: input.source.status,
          enabled: input.source.enabled,
          namespace: input.source.namespace,
          createdAt: input.source.createdAt,
          updatedAt: input.source.updatedAt,
        } satisfies typeof source.$inferInsert

        yield* db.insert(source).values(sourceRow).onConflictDoUpdate({
          target: source.id,
          set: {
            workspaceId: input.source.workspaceId,
            name: input.source.name,
            kind: input.source.kind,
            endpoint: input.source.endpoint,
            status: input.source.status,
            enabled: input.source.enabled,
            namespace: input.source.namespace,
            updatedAt: input.source.updatedAt,
          },
        })

        // Fetch existing tools for this source to compare hashes
        const existing = yield* db
          .select({
            toolId: catalog_tool.toolId,
            contentHash: catalog_tool.contentHash,
            sourceEnabled: catalog_tool.sourceEnabled,
            sourceStatus: catalog_tool.sourceStatus,
          })
          .from(catalog_tool)
          .where(eq(catalog_tool.sourceId, input.sourceId as typeof catalog_tool.$inferInsert.sourceId))

        const existingByToolId = new Map(
          existing.map((row) => [row.toolId, row]),
        )

        const incomingToolIds = new Set<string>()

        for (const tool of input.tools) {
          const searchText = buildSearchText(tool)
          const contentHash = computeContentHash(tool, searchText)
          incomingToolIds.add(tool.toolId)

          const existingRow = existingByToolId.get(tool.toolId)
          const existingHash = existingRow?.contentHash

          if (existingHash === contentHash) {
            const needsReactivation =
              existingRow?.sourceEnabled !== true
              || existingRow?.sourceStatus !== "connected"

            if (needsReactivation) {
              yield* db
                .update(catalog_tool)
                .set({
                  sourceEnabled: true,
                  sourceStatus: "connected",
                })
                .where(eq(catalog_tool.toolId, tool.toolId))
            }
            continue
          }

          if (existingHash !== undefined) {
            // Tool exists but changed — update
            yield* db
              .update(catalog_tool)
              .set({
                path: tool.path,
                sourceKey: tool.sourceKey,
                namespace: tool.namespace,
                title: tool.title ?? null,
                description: tool.description ?? null,
                searchText: searchText,
                inputSchemaJson: tool.inputSchemaJson ?? null,
                outputSchemaJson: tool.outputSchemaJson ?? null,
                inputTypePreview: tool.inputTypePreview ?? null,
                outputTypePreview: tool.outputTypePreview ?? null,
                interaction: tool.interaction ?? "auto",
                providerKind: tool.providerKind ?? null,
                contentHash: contentHash,
                sourceEnabled: true,
                sourceStatus: "connected",
              })
              .where(eq(catalog_tool.toolId, tool.toolId))
            changedTools.push(tool)
          } else {
            // New tool — insert
            const toolRow = {
              toolId: tool.toolId,
              path: tool.path,
              sourceId: input.sourceId as typeof catalog_tool.$inferInsert.sourceId,
              sourceKey: tool.sourceKey,
              namespace: tool.namespace,
              title: tool.title ?? null,
              description: tool.description ?? null,
              searchText: searchText,
              inputSchemaJson: tool.inputSchemaJson ?? null,
              outputSchemaJson: tool.outputSchemaJson ?? null,
              inputTypePreview: tool.inputTypePreview ?? null,
              outputTypePreview: tool.outputTypePreview ?? null,
              interaction: tool.interaction ?? "auto",
              providerKind: tool.providerKind ?? null,
              contentHash: contentHash,
              sourceEnabled: true,
              sourceStatus: "connected",
            } satisfies typeof catalog_tool.$inferInsert

            yield* db.insert(catalog_tool).values(toolRow)
            changedTools.push(tool)
          }
        }

        // Remove stale tools that no longer exist in the source
        const staleToolIds = existing
          .map((row) => row.toolId)
          .filter((id) => !incomingToolIds.has(id))

        if (staleToolIds.length > 0) {
          yield* db
            .delete(catalog_tool)
            .where(
              and(
                eq(catalog_tool.sourceId, input.sourceId as typeof catalog_tool.$inferInsert.sourceId),
                inArray(catalog_tool.toolId, staleToolIds),
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
export const deactivateSourceTools = (sourceId: SourceId) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle

    yield* db
      .update(catalog_tool)
      .set({
        sourceEnabled: false,
        sourceStatus: "disconnected",
      })
      .where(eq(catalog_tool.sourceId, sourceId as typeof catalog_tool.$inferInsert.sourceId))
  })

/**
 * Sync source metadata and lifecycle flags without treating missing tools as removal.
 * Used for sources that still exist but are currently disabled or disconnected.
 */
export const syncSourceLifecycle = (input: {
  sourceId: SourceId
  source: SourceToIndex
}) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle

    const sourceRow = {
      id: input.source.sourceId,
      workspaceId: input.source.workspaceId,
      name: input.source.name,
      kind: input.source.kind,
      endpoint: input.source.endpoint,
      status: input.source.status,
      enabled: input.source.enabled,
      namespace: input.source.namespace,
      createdAt: input.source.createdAt,
      updatedAt: input.source.updatedAt,
    } satisfies typeof source.$inferInsert

    yield* db.insert(source).values(sourceRow).onConflictDoUpdate({
      target: source.id,
      set: {
        workspaceId: input.source.workspaceId,
        name: input.source.name,
        kind: input.source.kind,
        endpoint: input.source.endpoint,
        status: input.source.status,
        enabled: input.source.enabled,
        namespace: input.source.namespace,
        updatedAt: input.source.updatedAt,
      },
    })

    yield* db
      .update(catalog_tool)
      .set({
        sourceEnabled: input.source.enabled,
        sourceStatus: input.source.status,
      })
      .where(eq(catalog_tool.sourceId, input.sourceId as typeof catalog_tool.$inferInsert.sourceId))
  })

// ---------------------------------------------------------------------------
// Remove source tools
// ---------------------------------------------------------------------------

/**
 * Delete all tools for a source from the catalog_tool table.
 * Used when a source is permanently removed.
 */
export const removeSourceTools = (sourceId: SourceId) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle

    yield* db
      .delete(catalog_tool)
      .where(eq(catalog_tool.sourceId, sourceId as typeof catalog_tool.$inferInsert.sourceId))
  })
