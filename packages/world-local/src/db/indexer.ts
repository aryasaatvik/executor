import { SqlClient } from "@effect/sql";
import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";
import { projectCatalogForAgentSdk } from "@executor/execution-ir/catalog";
import type { Capability, CatalogV1, Executable } from "@executor/execution-ir/model";
import {
  type Source,
  type SourceCatalogId,
  type SourceCatalogRevisionId,
  type SourceId,
  type WorkspaceId,
} from "@executor/core/model";
import {
  createSourceCatalogRecord,
  createSourceCatalogRevisionRecord,
  stableSourceCatalogId,
} from "@executor/core/services/sources/source-definitions";
import {
  contentHash,
  snapshotFromSourceCatalogSyncResult,
  type SourceCatalogSyncResult,
} from "@executor/source-core";
import { and, eq, inArray } from "drizzle-orm";
import * as Effect from "effect/Effect";

import {
  catalog,
  catalog_document,
  catalog_revision,
  catalog_tool,
  source,
  workspace_state,
} from "./schema";
import { VecService } from "./vec";

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

const buildSnapshotJson = (catalogValue: CatalogV1): string =>
  JSON.stringify({
    symbols: catalogValue.symbols,
    scopes: catalogValue.scopes,
    responseSets: catalogValue.responseSets,
    resources: catalogValue.resources,
    diagnostics: catalogValue.diagnostics,
  });

const chooseExecutableForCapability = (
  catalogValue: CatalogV1,
  capability: Capability,
): Executable | undefined => {
  if (capability.preferredExecutableId) {
    const preferred = catalogValue.executables[capability.preferredExecutableId];
    if (preferred) return preferred;
  }
  for (const execId of capability.executableIds) {
    const executable = catalogValue.executables[execId];
    if (executable) return executable;
  }
  return undefined;
};

const toolsFromProjection = (
  sourceValue: Source,
  catalogValue: CatalogV1,
): ToolToIndex[] => {
  const tools: ToolToIndex[] = [];
  try {
    const projection = projectCatalogForAgentSdk({ catalog: catalogValue });
    for (const [capabilityId, rawDescriptor] of Object.entries(projection.toolDescriptors)) {
      const descriptor = rawDescriptor as {
        toolPath: string[];
        title?: string;
        summary?: string;
        interaction: {
          mayRequireApproval: boolean;
        };
      };
      const toolPath = descriptor.toolPath.join(".");
      const capability = catalogValue.capabilities[capabilityId as keyof typeof catalogValue.capabilities];
      if (!capability) continue;
      const executable = chooseExecutableForCapability(catalogValue, capability);

      const namespace = descriptor.toolPath.length > 1
        ? descriptor.toolPath.slice(0, -1).join(".")
        : sourceValue.namespace ?? sourceValue.id;

      const searchDoc = projection.searchDocs[capabilityId as keyof typeof projection.searchDocs];
      const searchParts = [
        toolPath,
        namespace,
        sourceValue.name,
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

      tools.push({
        toolId: toolPath,
        path: toolPath,
        sourceId: sourceValue.id,
        sourceKey: sourceValue.id,
        namespace,
        searchText: searchParts,
        title: descriptor.title ?? capability.surface.title ?? undefined,
        description: descriptor.summary ?? capability.surface.summary ?? capability.surface.description ?? undefined,
        interaction: descriptor.interaction.mayRequireApproval ? "required" : "auto",
        providerKind: executable?.adapterKey ?? undefined,
        capabilityJson: JSON.stringify(capability),
        executableJson: executable ? JSON.stringify(executable) : null,
      });
    }
  } catch {
    // Projection failure — return empty tools.
  }
  return tools;
};

export const syncSourceToSqlite = (input: {
  source: Source;
  syncResult: SourceCatalogSyncResult;
}) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle;
    const sql = yield* SqlClient.SqlClient;
    const vec = yield* VecService;
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

        for (const [documentId, rawDocument] of Object.entries(snapshot.catalog.documents)) {
          const document = rawDocument as {
            native?: ReadonlyArray<{ kind?: string; value?: unknown }>;
          };
          const sourceDocBlob = document.native?.find(
            (blob: { kind?: string; value?: unknown }) =>
              blob.kind === "source_document" && typeof blob.value === "string",
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

        const existing = yield* db
          .select({
            toolId: catalog_tool.toolId,
            contentHash: catalog_tool.contentHash,
            sourceEnabled: catalog_tool.sourceEnabled,
            sourceStatus: catalog_tool.sourceStatus,
          })
          .from(catalog_tool)
          .where(eq(catalog_tool.sourceId, input.source.id as typeof catalog_tool.$inferInsert.sourceId));

        const existingByToolId = new Map(existing.map((row) => [row.toolId, row]));
        const incomingToolIds = new Set<string>();

        for (const tool of tools) {
          const searchText = buildSearchText(tool);
          const toolContentHash = computeContentHash(tool, searchText);
          incomingToolIds.add(tool.toolId);

          const existingRow = existingByToolId.get(tool.toolId);
          const existingHash = existingRow?.contentHash;

          if (existingHash === toolContentHash) {
            const needsReactivation =
              existingRow?.sourceEnabled !== true || existingRow?.sourceStatus !== "connected";

            if (needsReactivation || tool.capabilityJson) {
              yield* db
                .update(catalog_tool)
                .set({
                  ...(needsReactivation ? { sourceEnabled: true, sourceStatus: "connected" as const } : {}),
                  ...(tool.capabilityJson
                    ? { capabilityJson: tool.capabilityJson, executableJson: tool.executableJson ?? null }
                    : {}),
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
                searchText,
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
              searchText,
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
          yield* vec.removeVecTools(staleToolIds);
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

const SEMANTIC_SEARCH_SIGNATURE_KEY = "catalog.semanticSearchSignature";

export const loadSemanticSearchSignature = (
  workspaceId: WorkspaceId,
) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle;
    const rows = yield* db
      .select({ value: workspace_state.value })
      .from(workspace_state)
      .where(
        and(
          eq(workspace_state.workspaceId, workspaceId),
          eq(workspace_state.key, SEMANTIC_SEARCH_SIGNATURE_KEY),
        ),
      )
      .limit(1);
    return rows.length > 0 ? (rows[0].value ?? null) : null;
  });

export const writeSemanticSearchSignature = (
  workspaceId: WorkspaceId,
  signature: string | null,
) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle;
    const updatedAt = Date.now();
    yield* db.insert(workspace_state).values({
      workspaceId,
      key: SEMANTIC_SEARCH_SIGNATURE_KEY,
      value: signature,
      updatedAt,
    }).onConflictDoUpdate({
      target: [workspace_state.workspaceId, workspace_state.key],
      set: {
        value: signature,
        updatedAt,
      },
    });
  });
