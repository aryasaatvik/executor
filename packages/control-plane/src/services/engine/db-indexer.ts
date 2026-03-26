// Catalog SQLite indexer — copied from @executor/engine/src/db/indexer.ts
// Adapted to use control-plane local imports.
import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";
import { SqlClient } from "@effect/sql";
import { eq, and, inArray } from "drizzle-orm";
import * as Effect from "effect/Effect";
import type {
  Source,
  SourceCatalogId,
  SourceCatalogRevisionId,
  SourceId,
  SourceStatus,
  WorkspaceId,
} from "../../model/index";
import {
  catalog_tool,
  catalog,
  catalog_revision,
  catalog_document,
  source,
} from "./db-schema";
import { projectCatalogForAgentSdk } from "@executor/execution-ir/catalog";
import type { Capability, CatalogV1, Executable } from "@executor/execution-ir/model";
import type { ToolDescriptor as CatalogToolDescriptor, ToolContract } from "@executor/codemode-core";
import {
  contentHash,
  snapshotFromSourceCatalogSyncResult,
  type SourceCatalogSyncResult,
} from "@executor/source-core";
import {
  createSourceCatalogRecord,
  createSourceCatalogRevisionRecord,
  stableSourceCatalogId,
} from "../sources/source-definitions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolToIndex {
  toolId: string;
  path: string;
  sourceId: SourceId;
  sourceKey: string;
  namespace: string;
  searchText?: string;
  title?: string;
  description?: string;
  inputSchemaJson?: unknown;
  outputSchemaJson?: unknown;
  inputTypePreview?: string;
  outputTypePreview?: string;
  interaction?: string;
  providerKind?: string;
  capabilityJson?: string;
  executableJson?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const buildSearchText = (tool: ToolToIndex): string => {
  const lines: string[] = [];
  lines.push(`path: ${tool.path}`);
  lines.push(`source: ${tool.sourceKey}`);
  lines.push(`namespace: ${tool.namespace}`);
  if (tool.searchText) lines.push(`search: ${tool.searchText}`);
  if (tool.title) lines.push(`title: ${tool.title}`);
  if (tool.description) lines.push(`description: ${tool.description}`);
  const params = extractParams(tool.inputSchemaJson);
  if (params.length > 0) lines.push(`params: ${params.join(" ")}`);
  return lines.join("\n");
};

const extractParams = (schema: unknown): string[] => {
  if (schema === null || schema === undefined || typeof schema !== "object") return [];
  const obj = schema as Record<string, unknown>;
  const properties = obj.properties;
  if (properties === null || properties === undefined || typeof properties !== "object") return [];
  const props = properties as Record<string, unknown>;
  return Object.entries(props).map(([name, def]) => {
    const typeName =
      def !== null &&
      def !== undefined &&
      typeof def === "object" &&
      "type" in def &&
      typeof (def as Record<string, unknown>).type === "string"
        ? ` (${(def as Record<string, unknown>).type as string})`
        : "";
    return `${name}${typeName}`;
  });
};

const computeContentHash = (tool: ToolToIndex, searchText: string): string => {
  const hasher = new Bun.CryptoHasher("sha256");
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
  }));
  return hasher.digest("hex") as string;
};

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
  });

const chooseExecutableForCapability = (
  cat: CatalogV1,
  capability: Capability,
): Executable | undefined => {
  if (capability.preferredExecutableId) {
    const preferred = cat.executables[capability.preferredExecutableId];
    if (preferred) return preferred;
  }
  for (const execId of capability.executableIds) {
    const exec = cat.executables[execId];
    if (exec) return exec;
  }
  return undefined;
};

const toolsFromProjection = (
  src: Source,
  cat: CatalogV1,
): ToolToIndex[] => {
  const tools: ToolToIndex[] = [];
  try {
    const projection = projectCatalogForAgentSdk({ catalog: cat });
    for (const [capId, descriptor] of Object.entries(projection.toolDescriptors)) {
      const toolPath = descriptor.toolPath.join(".");
      const capability = cat.capabilities[capId as keyof typeof cat.capabilities];
      if (!capability) continue;
      const executable = chooseExecutableForCapability(cat, capability);

      const namespace = descriptor.toolPath.length > 1
        ? descriptor.toolPath.slice(0, -1).join(".")
        : src.namespace ?? src.id;

      const searchDoc = projection.searchDocs[capId as keyof typeof projection.searchDocs];
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
        .toLowerCase();

      const interaction = descriptor.interaction.mayRequireApproval ? "required" : "auto";

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
      });
    }
  } catch {
    // Projection failure — return empty tools
  }
  return tools;
};

// ---------------------------------------------------------------------------
// syncSourceToSqlite
// ---------------------------------------------------------------------------

export const syncSourceToSqlite = (input: {
  source: Source;
  syncResult: SourceCatalogSyncResult;
}) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle;
    const sql = yield* SqlClient.SqlClient;
    const changedTools: ToolToIndex[] = [];

    const snapshot = snapshotFromSourceCatalogSyncResult(input.syncResult);
    const catalogId = stableSourceCatalogId(input.source);
    const snapshotHashValue = contentHash(JSON.stringify(snapshot));
    const importMetadataJsonStr = JSON.stringify(snapshot.import);
    const importMetadataHashValue = contentHash(importMetadataJsonStr);
    const now = Date.now();

    const catalogRecord = createSourceCatalogRecord({
      source: input.source,
      catalogId,
      latestRevisionId: null as unknown as SourceCatalogRevisionId,
    });
    const revisionRecord = createSourceCatalogRevisionRecord({
      source: input.source,
      catalogId,
      revisionNumber: 1,
      importMetadataJson: importMetadataJsonStr,
      importMetadataHash: importMetadataHashValue,
      snapshotHash: snapshotHashValue,
    });

    const tools = toolsFromProjection(input.source, snapshot.catalog);

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
        });

        // --- catalog_revision row ---
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
        });

        // --- catalog_document rows ---
        for (const [documentId, document] of Object.entries(snapshot.catalog.documents)) {
          const sourceDocBlob = document.native?.find(
            (blob) => blob.kind === "source_document" && typeof blob.value === "string",
          );
          const docContent = sourceDocBlob?.value;
          if (typeof docContent !== "string") continue;

          const docRowId = `${revisionRecord.id}:${documentId}`;
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
          });
        }

        // --- source row ---
        yield* db.insert(source).values({
          id: input.source.id,
          workspaceId: input.source.workspaceId,
          catalogId: catalogRecord.id,
          catalogRevisionId: revisionRecord.id,
          status: input.source.status,
          enabled: input.source.enabled,
          sourceHash: input.source.sourceHash,
          lastError: input.source.lastError,
          createdAt: input.source.createdAt,
          updatedAt: now,
        }).onConflictDoUpdate({
          target: source.id,
          set: {
            catalogId: catalogRecord.id,
            catalogRevisionId: revisionRecord.id,
            status: input.source.status,
            enabled: input.source.enabled,
            sourceHash: input.source.sourceHash,
            lastError: input.source.lastError,
            updatedAt: now,
          },
        });

        // --- catalog_tool rows ---
        const existing = yield* db
          .select({
            toolId: catalog_tool.toolId,
            contentHash: catalog_tool.contentHash,
            sourceEnabled: catalog_tool.sourceEnabled,
            sourceStatus: catalog_tool.sourceStatus,
          })
          .from(catalog_tool)
          .where(eq(catalog_tool.sourceId, input.source.id as typeof catalog_tool.$inferInsert.sourceId));

        const existingByToolId = new Map(
          existing.map((row) => [row.toolId, row]),
        );

        const incomingToolIds = new Set<string>();

        for (const tool of tools) {
          const searchText = buildSearchText(tool);
          const toolContentHash = computeContentHash(tool, searchText);
          incomingToolIds.add(tool.toolId);

          const existingRow = existingByToolId.get(tool.toolId);
          const existingHash = existingRow?.contentHash;

          if (existingHash === toolContentHash) {
            const needsReactivation =
              existingRow?.sourceEnabled !== true
              || existingRow?.sourceStatus !== "connected";

            if (needsReactivation || tool.capabilityJson) {
              yield* db
                .update(catalog_tool)
                .set({
                  ...(needsReactivation ? { sourceEnabled: true, sourceStatus: "connected" as const } : {}),
                  ...(tool.capabilityJson ? { capabilityJson: tool.capabilityJson, executableJson: tool.executableJson ?? null } : {}),
                })
                .where(eq(catalog_tool.toolId, tool.toolId));
            }
            continue;
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
              .where(eq(catalog_tool.toolId, tool.toolId));
            changedTools.push(tool);
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
            });
            changedTools.push(tool);
          }
        }

        // Remove stale tools
        const staleToolIds = existing
          .map((row) => row.toolId)
          .filter((id) => !incomingToolIds.has(id));

        if (staleToolIds.length > 0) {
          yield* db
            .delete(catalog_tool)
            .where(
              and(
                eq(catalog_tool.sourceId, input.source.id as typeof catalog_tool.$inferInsert.sourceId),
                inArray(catalog_tool.toolId, staleToolIds),
              ),
            );
          // Note: removeVecTools omitted — vec table management lives in engine
        }
      }),
    );

    return {
      snapshot,
      catalogId,
      revisionId: revisionRecord.id,
      changedTools,
    } as const;
  });
