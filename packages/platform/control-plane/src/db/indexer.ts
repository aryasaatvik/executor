import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite"
import { SqlClient } from "@effect/sql"
import { eq, and, inArray } from "drizzle-orm"
import * as Effect from "effect/Effect"
import type {
  Source,
  SourceCatalogId,
  SourceCatalogRevisionId,
  SourceId,
  SourceKind,
  SourceStatus,
  WorkspaceId,
} from "#schema"
import { catalog_tool, catalog, catalog_revision, catalog_document, source, workspace_state } from "./schema"
import { removeVecTools } from "./vec"
import { projectCatalogForAgentSdk } from "@executor/ir/catalog"
import type { Capability, CatalogV1, Executable } from "@executor/ir/model"
import type { ToolDescriptor as CatalogToolDescriptor, ToolContract } from "@executor/codemode-core"
import {
  contentHash,
  snapshotFromSourceCatalogSyncResult,
  type SourceCatalogSyncResult,
} from "@executor/source-core"
import {
  createSourceCatalogRecord,
  createSourceCatalogRevisionRecord,
  stableSourceCatalogId,
} from "../runtime/sources/source-definitions"

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
  capabilityJson?: string
  executableJson?: string | null
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
                ...(tool.capabilityJson !== undefined ? { capabilityJson: tool.capabilityJson } : {}),
                ...(tool.executableJson !== undefined ? { executableJson: tool.executableJson } : {}),
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
              capabilityJson: tool.capabilityJson ?? null,
              executableJson: tool.executableJson ?? null,
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

/**
 * Check whether a source has catalog data in SQLite (at least one catalog_tool row).
 */
export const hasSourceCatalogData = (sourceId: SourceId) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle
    const rows = yield* db
      .select({ toolId: catalog_tool.toolId })
      .from(catalog_tool)
      .where(eq(catalog_tool.sourceId, sourceId as typeof catalog_tool.$inferInsert.sourceId))
      .limit(1)
    return rows.length > 0
  })

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

const buildSnapshotJson = (cat: CatalogV1): string =>
  JSON.stringify({
    symbols: cat.symbols,
    scopes: cat.scopes,
    responseSets: cat.responseSets,
    resources: cat.resources,
    diagnostics: cat.diagnostics,
  })

const chooseExecutableForCapability = (
  cat: CatalogV1,
  capability: Capability,
): Executable | undefined => {
  if (capability.preferredExecutableId) {
    const preferred = cat.executables[capability.preferredExecutableId]
    if (preferred) return preferred
  }
  for (const execId of capability.executableIds) {
    const exec = cat.executables[execId]
    if (exec) return exec
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Sync source catalog to SQLite
// ---------------------------------------------------------------------------

/**
 * Build ToolToIndex entries directly from a catalog snapshot and its projection.
 * Used by syncSourceToSqlite to avoid needing the full runtime catalog store.
 */
const toolsFromProjection = (
  src: Source,
  cat: CatalogV1,
): ToolToIndex[] => {
  const tools: ToolToIndex[] = []
  try {
    const projection = projectCatalogForAgentSdk({ catalog: cat })
    for (const [capId, descriptor] of Object.entries(projection.toolDescriptors)) {
      const toolPath = descriptor.toolPath.join(".")
      const capability = cat.capabilities[capId as keyof typeof cat.capabilities]
      if (!capability) continue
      const executable = chooseExecutableForCapability(cat, capability)

      const namespace = descriptor.toolPath.length > 1
        ? descriptor.toolPath.slice(0, -1).join(".")
        : src.namespace ?? src.id

      const searchDoc = projection.searchDocs[capId as keyof typeof projection.searchDocs]
      const searchParts = [
        toolPath,
        namespace,
        src.name,
        capability.surface.title,
        capability.surface.summary,
        capability.surface.description,
        ...(searchDoc?.tags ?? []),
        ...(searchDoc?.protocolHints ?? []),
        ...(searchDoc?.authHints ?? []),
      ]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join(" ")
        .toLowerCase()

      const interaction = descriptor.interaction.mayRequireApproval ? "required" : "auto"

      tools.push({
        toolId: toolPath,
        path: toolPath,
        sourceId: src.id,
        sourceKey: src.id,
        namespace,
        searchText: searchParts,
        title: descriptor.title ?? capability.surface.title ?? undefined,
        description: descriptor.summary ?? capability.surface.summary ?? capability.surface.description ?? undefined,
        interaction,
        providerKind: executable?.adapterKey ?? undefined,
        capabilityJson: JSON.stringify(capability),
        executableJson: executable ? JSON.stringify(executable) : null,
      })
    }
  } catch {
    // Projection failure — return empty tools, catalog/revision still gets written
  }
  return tools
}

/**
 * Full catalog sync to SQLite: writes catalog, revision, documents, and tools
 * in a single transaction. Replaces the file-based artifact write path.
 */
export const syncSourceToSqlite = (input: {
  source: Source
  syncResult: SourceCatalogSyncResult
}) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle
    const sql = yield* SqlClient.SqlClient
    const changedTools: ToolToIndex[] = []

    const snapshot = snapshotFromSourceCatalogSyncResult(input.syncResult)
    const catalogId = stableSourceCatalogId(input.source)
    const snapshotHashValue = contentHash(JSON.stringify(snapshot))
    const importMetadataJsonStr = JSON.stringify(snapshot.import)
    const importMetadataHashValue = contentHash(importMetadataJsonStr)
    const now = Date.now()

    const catalogRecord = createSourceCatalogRecord({
      source: input.source,
      catalogId,
      latestRevisionId: null as unknown as SourceCatalogRevisionId,
    })
    const revisionRecord = createSourceCatalogRevisionRecord({
      source: input.source,
      catalogId,
      revisionNumber: 1,
      importMetadataJson: importMetadataJsonStr,
      importMetadataHash: importMetadataHashValue,
      snapshotHash: snapshotHashValue,
    })

    const tools = toolsFromProjection(input.source, snapshot.catalog)

    yield* sql.withTransaction(
      Effect.gen(function* () {
        // --- catalog parent row ---
        yield* db.insert(catalog).values({
          id: catalogRecord.id,
          kind: catalogRecord.kind,
          adapterKey: catalogRecord.adapterKey,
          providerKey: catalogRecord.providerKey,
          name: catalogRecord.name,
          summary: catalogRecord.summary ?? null,
          visibility: catalogRecord.visibility,
          latestRevisionId: revisionRecord.id,
          createdAt: catalogRecord.createdAt,
          updatedAt: now,
        }).onConflictDoUpdate({
          target: catalog.id,
          set: {
            name: catalogRecord.name,
            latestRevisionId: revisionRecord.id,
            updatedAt: now,
          },
        })

        // --- catalog_revision row with snapshot_json ---
        yield* db.insert(catalog_revision).values({
          id: revisionRecord.id,
          catalogId: revisionRecord.catalogId,
          revisionNumber: revisionRecord.revisionNumber,
          sourceConfigJson: revisionRecord.sourceConfigJson,
          importMetadataJson: revisionRecord.importMetadataJson,
          importMetadataHash: revisionRecord.importMetadataHash,
          snapshotHash: revisionRecord.snapshotHash,
          snapshotJson: buildSnapshotJson(snapshot.catalog),
          createdAt: revisionRecord.createdAt,
          updatedAt: now,
        }).onConflictDoUpdate({
          target: catalog_revision.id,
          set: {
            importMetadataJson: revisionRecord.importMetadataJson,
            importMetadataHash: revisionRecord.importMetadataHash,
            snapshotHash: revisionRecord.snapshotHash,
            snapshotJson: buildSnapshotJson(snapshot.catalog),
            updatedAt: now,
          },
        })

        // --- catalog_document rows ---
        for (const [documentId, document] of Object.entries(snapshot.catalog.documents)) {
          const sourceDocBlob = document.native?.find(
            (blob) => blob.kind === "source_document" && typeof blob.value === "string",
          )
          const docContent = sourceDocBlob?.value
          if (typeof docContent !== "string") continue

          const docRowId = `${revisionRecord.id}:${documentId}`
          yield* db.insert(catalog_document).values({
            id: docRowId,
            revisionId: revisionRecord.id,
            documentId,
            content: docContent,
            createdAt: now,
          }).onConflictDoUpdate({
            target: catalog_document.id,
            set: {
              content: docContent,
            },
          })
        }

        // --- source row ---
        yield* db.insert(source).values({
          id: input.source.id,
          workspaceId: input.source.workspaceId,
          catalogId: catalogRecord.id,
          catalogRevisionId: revisionRecord.id,
          name: input.source.name,
          kind: input.source.kind,
          endpoint: input.source.endpoint,
          status: input.source.status,
          enabled: input.source.enabled,
          namespace: input.source.namespace,
          createdAt: input.source.createdAt,
          updatedAt: now,
        }).onConflictDoUpdate({
          target: source.id,
          set: {
            catalogId: catalogRecord.id,
            catalogRevisionId: revisionRecord.id,
            name: input.source.name,
            kind: input.source.kind,
            endpoint: input.source.endpoint,
            status: input.source.status,
            enabled: input.source.enabled,
            namespace: input.source.namespace,
            updatedAt: now,
          },
        })

        // --- catalog_tool rows (index + capability/executable JSON) ---
        const existing = yield* db
          .select({
            toolId: catalog_tool.toolId,
            contentHash: catalog_tool.contentHash,
            sourceEnabled: catalog_tool.sourceEnabled,
            sourceStatus: catalog_tool.sourceStatus,
          })
          .from(catalog_tool)
          .where(eq(catalog_tool.sourceId, input.source.id as typeof catalog_tool.$inferInsert.sourceId))

        const existingByToolId = new Map(
          existing.map((row) => [row.toolId, row]),
        )

        const incomingToolIds = new Set<string>()

        for (const tool of tools) {
          const searchText = buildSearchText(tool)
          const toolContentHash = computeContentHash(tool, searchText)
          incomingToolIds.add(tool.toolId)

          const existingRow = existingByToolId.get(tool.toolId)
          const existingHash = existingRow?.contentHash

          if (existingHash === toolContentHash) {
            const needsReactivation =
              existingRow?.sourceEnabled !== true
              || existingRow?.sourceStatus !== "connected"

            if (needsReactivation || tool.capabilityJson) {
              yield* db
                .update(catalog_tool)
                .set({
                  ...(needsReactivation ? { sourceEnabled: true, sourceStatus: "connected" as const } : {}),
                  ...(tool.capabilityJson ? { capabilityJson: tool.capabilityJson, executableJson: tool.executableJson ?? null } : {}),
                })
                .where(eq(catalog_tool.toolId, tool.toolId))
            }
            continue
          }

          if (existingHash !== undefined) {
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
                contentHash: toolContentHash,
                sourceEnabled: true,
                sourceStatus: "connected",
                capabilityJson: tool.capabilityJson ?? null,
                executableJson: tool.executableJson ?? null,
              })
              .where(eq(catalog_tool.toolId, tool.toolId))
            changedTools.push(tool)
          } else {
            yield* db.insert(catalog_tool).values({
              toolId: tool.toolId,
              path: tool.path,
              sourceId: input.source.id as typeof catalog_tool.$inferInsert.sourceId,
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
              contentHash: toolContentHash,
              sourceEnabled: true,
              sourceStatus: "connected",
              capabilityJson: tool.capabilityJson ?? null,
              executableJson: tool.executableJson ?? null,
            })
            changedTools.push(tool)
          }
        }

        // Remove stale tools
        const staleToolIds = existing
          .map((row) => row.toolId)
          .filter((id) => !incomingToolIds.has(id))

        if (staleToolIds.length > 0) {
          yield* db
            .delete(catalog_tool)
            .where(
              and(
                eq(catalog_tool.sourceId, input.source.id as typeof catalog_tool.$inferInsert.sourceId),
                inArray(catalog_tool.toolId, staleToolIds),
              ),
            )
          yield* removeVecTools(staleToolIds)
        }
      }),
    )

    return {
      snapshot,
      catalogId,
      revisionId: revisionRecord.id,
      changedTools,
    } as const
  })

// ---------------------------------------------------------------------------
// Load tool for invocation from SQLite
// ---------------------------------------------------------------------------

/**
 * Data returned by loadToolForInvocation — catalog data needed for adapter.invoke().
 */
export interface DbLoadedToolData {
  path: string
  sourceId: SourceId
  sourceKey: string
  namespace: string
  capability: Capability
  executable: Executable
  descriptor: CatalogToolDescriptor
  catalog: CatalogV1
}

/**
 * Load a single tool by path from SQLite with enough catalog data for invocation.
 *
 * Queries catalog_tool for capability_json + executable_json,
 * fetches catalog_revision.snapshot_json via the source's catalog_revision_id
 * to reconstruct a CatalogV1 with symbols/scopes/responseSets.
 *
 * Does NOT return a full Source object — the caller should load that from
 * SourceStore which handles bindings, auth, etc.
 */
export const loadToolForInvocation = (
  toolPath: string,
): Effect.Effect<DbLoadedToolData | null, Error, SqliteDrizzle> =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle

    // Query catalog_tool + source (for catalog_revision_id only)
    const rows = yield* db
      .select({
        path: catalog_tool.path,
        sourceId: catalog_tool.sourceId,
        sourceKey: catalog_tool.sourceKey,
        namespace: catalog_tool.namespace,
        description: catalog_tool.description,
        interaction: catalog_tool.interaction,
        inputSchemaJson: catalog_tool.inputSchemaJson,
        outputSchemaJson: catalog_tool.outputSchemaJson,
        inputTypePreview: catalog_tool.inputTypePreview,
        outputTypePreview: catalog_tool.outputTypePreview,
        providerKind: catalog_tool.providerKind,
        capabilityJson: catalog_tool.capabilityJson,
        executableJson: catalog_tool.executableJson,
        sourceEnabled: catalog_tool.sourceEnabled,
        sourceStatus: catalog_tool.sourceStatus,
        catalogRevisionId: source.catalogRevisionId,
      })
      .from(catalog_tool)
      .innerJoin(source, eq(catalog_tool.sourceId, source.id))
      .where(eq(catalog_tool.toolId, toolPath))
      .limit(1)

    if (rows.length === 0) return null

    const row = rows[0]

    // Must have capability_json and executable_json
    if (!row.capabilityJson || !row.executableJson) return null

    // Must be enabled and connected
    if (!row.sourceEnabled || row.sourceStatus !== "connected") return null

    const capability = JSON.parse(row.capabilityJson) as Capability
    const executable = JSON.parse(row.executableJson) as Executable

    // Build the CatalogToolDescriptor from DB columns
    const contract: ToolContract = {
      ...(row.inputTypePreview != null ? { inputTypePreview: row.inputTypePreview } : {}),
      ...(row.outputTypePreview != null ? { outputTypePreview: row.outputTypePreview } : {}),
      ...(row.inputSchemaJson != null ? { inputSchema: row.inputSchemaJson } : {}),
      ...(row.outputSchemaJson != null ? { outputSchema: row.outputSchemaJson } : {}),
    }

    const descriptor: CatalogToolDescriptor = {
      path: row.path as CatalogToolDescriptor["path"],
      sourceKey: row.sourceKey,
      ...(row.description != null ? { description: row.description } : {}),
      interaction: (row.interaction ?? "auto") as "auto" | "required",
      ...(Object.keys(contract).length > 0 ? { contract } : {}),
      ...(row.providerKind != null ? { providerKind: row.providerKind } : {}),
    }

    // Get snapshot_json from catalog_revision for symbols, scopes, etc.
    let snapshotData: {
      symbols?: CatalogV1["symbols"]
      scopes?: CatalogV1["scopes"]
      responseSets?: CatalogV1["responseSets"]
      resources?: CatalogV1["resources"]
      diagnostics?: CatalogV1["diagnostics"]
    } = {}

    if (row.catalogRevisionId) {
      const revRows = yield* db
        .select({ snapshotJson: catalog_revision.snapshotJson })
        .from(catalog_revision)
        .where(eq(catalog_revision.id, row.catalogRevisionId))
        .limit(1)

      if (revRows.length > 0 && revRows[0].snapshotJson) {
        try {
          snapshotData = JSON.parse(revRows[0].snapshotJson)
        } catch {
          // Invalid snapshot_json — proceed with empty data
        }
      }
    }

    // Reconstruct a minimal CatalogV1 for the adapter
    const reconstructedCatalog: CatalogV1 = {
      version: "ir.v1",
      documents: {} as CatalogV1["documents"],
      resources: (snapshotData.resources ?? {}) as CatalogV1["resources"],
      scopes: (snapshotData.scopes ?? {}) as CatalogV1["scopes"],
      symbols: (snapshotData.symbols ?? {}) as CatalogV1["symbols"],
      capabilities: { [capability.id]: capability } as unknown as CatalogV1["capabilities"],
      executables: { [executable.id]: executable } as unknown as CatalogV1["executables"],
      responseSets: (snapshotData.responseSets ?? {}) as CatalogV1["responseSets"],
      diagnostics: (snapshotData.diagnostics ?? {}) as CatalogV1["diagnostics"],
    }

    return {
      path: row.path,
      sourceId: row.sourceId,
      sourceKey: row.sourceKey,
      namespace: row.namespace,
      capability,
      executable,
      descriptor,
      catalog: reconstructedCatalog,
    } satisfies DbLoadedToolData
  })

// ---------------------------------------------------------------------------
// Workspace state: semantic search signature (workspace_state KV table)
// ---------------------------------------------------------------------------

const SEMANTIC_SEARCH_SIGNATURE_KEY = "catalog.semanticSearchSignature"

export const loadSemanticSearchSignature = (
  workspaceId: WorkspaceId,
) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle
    const rows = yield* db
      .select({ value: workspace_state.value })
      .from(workspace_state)
      .where(
        and(
          eq(workspace_state.workspaceId, workspaceId),
          eq(workspace_state.key, SEMANTIC_SEARCH_SIGNATURE_KEY),
        ),
      )
      .limit(1)
    return rows.length > 0 ? (rows[0].value ?? null) : null
  })

export const writeSemanticSearchSignature = (
  workspaceId: WorkspaceId,
  signature: string | null,
) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle
    yield* db.insert(workspace_state).values({
      workspaceId,
      key: SEMANTIC_SEARCH_SIGNATURE_KEY,
      value: signature,
      updatedAt: Date.now(),
    }).onConflictDoUpdate({
      target: [workspace_state.workspaceId, workspace_state.key],
      set: {
        value: signature,
        updatedAt: Date.now(),
      },
    })
  })

// ---------------------------------------------------------------------------
// Source status: read/write from source table
// ---------------------------------------------------------------------------
