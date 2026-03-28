// Source inspection functions — copied from @executor/engine/src/runtime/catalog/source/runtime.ts
// Adapted to use control-plane local imports instead of engine internals.
import {
  type ToolCatalogEntry,
  type ToolDescriptor as CatalogToolDescriptor,
} from "@executor/codemode-core";
import type {
  Source,
  SourceId,
  SourceCatalogId,
  SourceCatalogRevisionId,
  StoredSourceCatalogRevisionRecord,
  WorkspaceId,
} from "../../model/index";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";
import { eq } from "drizzle-orm";
import {
  catalog_tool,
  catalog_revision,
  catalog_document,
  source as sourceTable,
} from "./db-schema";

import {
  projectCatalogForAgentSdk,
  type ProjectedCatalog,
} from "@executor/execution-ir/catalog";
import type { ShapeSymbolId } from "@executor/execution-ir/ids";
import type {
  Capability,
  CatalogSnapshotV1,
  CatalogV1,
  Executable,
  ShapeSymbol,
} from "@executor/execution-ir/model";
import { LocalSourceArtifactMissingError } from "./local-errors";
import {
  createCatalogTypeProjector,
  documentationComment,
  joinTypeNameSegments,
  projectedCatalogTypeRoots,
  shapeAllowsOmittedArgs,
  type CatalogTypeProjector,
} from "../catalog/catalog-typescript";
import { formatWithPrettier } from "./prettier-format";
import {
  RuntimeLocalWorkspace,
  type RuntimeLocalWorkspaceState,
} from "./runtime-context";
import { WorkspaceDatabase } from "./workspace-database";
import { SourceStore } from "../sources/source-service";
import { runtimeEffectError } from "./errors";

type CatalogImportMetadata = CatalogSnapshotV1["import"];

type ProjectedToolDescriptor = ProjectedCatalog["toolDescriptors"][keyof ProjectedCatalog["toolDescriptors"]];

export type LoadedSourceCatalog = {
  source: Source;
  revision: StoredSourceCatalogRevisionRecord;
  snapshot: CatalogSnapshotV1;
  catalog: CatalogV1;
  projected: ProjectedCatalog;
  typeProjector: CatalogTypeProjector;
  importMetadata: CatalogImportMetadata;
};

export type LoadedSourceCatalogTool = {
  path: string;
  searchNamespace: string;
  searchText: string;
  source: Source;
  revision: StoredSourceCatalogRevisionRecord;
  capabilityId: keyof CatalogV1["capabilities"];
  executableId: keyof CatalogV1["executables"];
  capability: Capability;
  executable: Executable;
  projectedDescriptor: ProjectedToolDescriptor;
  descriptor: CatalogToolDescriptor;
  projectedCatalog: CatalogV1;
  typeProjector: CatalogTypeProjector;
};

export type LoadedSourceCatalogToolIndexEntry = Omit<
  LoadedSourceCatalogTool,
  "revision" | "projectedDescriptor" | "typeProjector"
>;

export type LoadedSourceCatalogToolContractSide = {
  shapeId: string | null;
  typePreview: string | null;
  typeDeclaration: string | null;
  schemaJson: string | null;
  exampleJson: string | null;
};

export type LoadedSourceCatalogToolContract = {
  callSignature: string;
  callDeclaration: string;
  callShapeId: string;
  resultShapeId: string | null;
  responseSetId: string;
  input: LoadedSourceCatalogToolContractSide;
  output: LoadedSourceCatalogToolContractSide;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const catalogNamespaceFromPath = (path: string): string => {
  const [first, second] = path.split(".");
  return second ? `${first}.${second}` : first;
};

const descriptorPath = (descriptor: CatalogToolDescriptor): string => descriptor.path;

const optionalJsonString = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  return JSON.stringify(value, null, 2);
};

const projectedToolPath = (projected: ProjectedCatalog, capability: Capability): string =>
  projected.toolDescriptors[capability.id]?.toolPath.join(".") ?? "";

const chooseExecutable = (catalog: CatalogV1, capability: Capability): Executable => {
  const preferred =
    capability.preferredExecutableId !== undefined
      ? catalog.executables[capability.preferredExecutableId]
      : undefined;
  if (preferred) {
    return preferred;
  }
  const first = capability.executableIds
    .map((id) => catalog.executables[id])
    .find((entry): entry is Executable => entry !== undefined);
  if (!first) {
    throw new Error(`Capability ${capability.id} has no executable`);
  }
  return first;
};

const asShape = (catalog: CatalogV1, shapeId: string | undefined): ShapeSymbol | undefined => {
  if (!shapeId) {
    return undefined;
  }
  const symbol = catalog.symbols[shapeId];
  return symbol?.kind === "shape" ? symbol : undefined;
};

// ---------------------------------------------------------------------------
// JSON Schema builder (from engine's shapeToJsonSchema)
// ---------------------------------------------------------------------------

export const shapeToJsonSchema = (catalog: CatalogV1, rootShapeId: string): unknown => {
  const defs: Record<string, unknown> = {};
  const inlineStack = new Set<string>();
  const buildingDefs = new Set<string>();
  const builtDefs = new Set<string>();
  const defNameByShapeId = new Map<string, string>();
  const usedDefNames = new Set<string>();

  const sanitizeDefName = (value: string): string | null => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const sanitized = trimmed
      .replace(/[^A-Za-z0-9_]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (sanitized.length === 0) return null;
    return /^[A-Za-z_]/.test(sanitized) ? sanitized : `shape_${sanitized}`;
  };

  const shapeLabelCandidates = (shapeId: string, suggestions: readonly string[]): string[] => {
    const shape = asShape(catalog, shapeId);
    return [
      ...suggestions,
      shape?.title,
      shapeId,
    ].flatMap((candidate) =>
      typeof candidate === "string" && candidate.trim().length > 0
        ? [candidate]
        : [],
    );
  };

  const defNameFor = (shapeId: string, suggestions: readonly string[]): string => {
    const existing = defNameByShapeId.get(shapeId);
    if (existing) return existing;
    const candidates = shapeLabelCandidates(shapeId, suggestions);
    for (const candidate of candidates) {
      const sanitized = sanitizeDefName(candidate);
      if (!sanitized) continue;
      if (!usedDefNames.has(sanitized)) {
        defNameByShapeId.set(shapeId, sanitized);
        usedDefNames.add(sanitized);
        return sanitized;
      }
    }
    const fallbackBase = sanitizeDefName(shapeId) ?? "shape";
    let fallback = fallbackBase;
    let index = 2;
    while (usedDefNames.has(fallback)) {
      fallback = `${fallbackBase}_${String(index)}`;
      index += 1;
    }
    defNameByShapeId.set(shapeId, fallback);
    usedDefNames.add(fallback);
    return fallback;
  };

  const primaryLabel = (shapeId: string, suggestions: readonly string[], fallback: string): string =>
    shapeLabelCandidates(shapeId, suggestions)[0] ?? fallback;

  const isShallowInlineCandidate = (
    shapeId: string,
    depth: number,
    seen: ReadonlySet<string>,
  ): boolean => {
    const shape = asShape(catalog, shapeId);
    if (!shape) return true;
    if (depth < 0 || seen.has(shapeId)) return false;
    const nextSeen = new Set(seen);
    nextSeen.add(shapeId);
    return Match.value(shape.node).pipe(
      Match.when({ type: "unknown" }, () => true),
      Match.when({ type: "const" }, () => true),
      Match.when({ type: "enum" }, () => true),
      Match.when({ type: "scalar" }, () => true),
      Match.when({ type: "ref" }, (node) =>
        isShallowInlineCandidate(node.target, depth, nextSeen)),
      Match.when({ type: "nullable" }, (node) =>
        isShallowInlineCandidate(node.itemShapeId, depth - 1, nextSeen)),
      Match.when({ type: "array" }, (node) =>
        isShallowInlineCandidate(node.itemShapeId, depth - 1, nextSeen)),
      Match.when({ type: "object" }, (node) => {
        const fields = Object.values(node.fields);
        return fields.length <= 8
          && fields.every((field) =>
            isShallowInlineCandidate(field.shapeId, depth - 1, nextSeen));
      }),
      Match.orElse(() => false),
    );
  };

  const shouldInlineRefTarget = (shapeId: string): boolean =>
    isShallowInlineCandidate(shapeId, 2, new Set<string>());

  const buildInline = (
    shapeId: string,
    suggestions: readonly string[] = [],
  ): Record<string, unknown> => {
    if (inlineStack.has(shapeId)) {
      return buildRef(shapeId, suggestions);
    }
    const shape = asShape(catalog, shapeId);
    if (!shape) return {};
    inlineStack.add(shapeId);
    try {
      return buildSchema(shapeId, suggestions);
    } finally {
      inlineStack.delete(shapeId);
    }
  };

  const buildRef = (
    shapeId: string,
    suggestions: readonly string[] = [],
  ): { $ref: string } => {
    const defName = defNameFor(shapeId, suggestions);
    if (builtDefs.has(shapeId) || buildingDefs.has(shapeId)) {
      return { $ref: `#/$defs/${defName}` };
    }
    const shape = asShape(catalog, shapeId);
    buildingDefs.add(shapeId);
    const alreadyInline = inlineStack.has(shapeId);
    if (!alreadyInline) inlineStack.add(shapeId);
    try {
      defs[defName] = shape ? buildSchema(shapeId, suggestions) : {};
      builtDefs.add(shapeId);
    } finally {
      buildingDefs.delete(shapeId);
      if (!alreadyInline) inlineStack.delete(shapeId);
    }
    return { $ref: `#/$defs/${defName}` };
  };

  const buildSchema = (
    shapeId: string,
    suggestions: readonly string[] = [],
  ): Record<string, unknown> => {
    const shape = asShape(catalog, shapeId);
    if (!shape) return {};
    const label = primaryLabel(shapeId, suggestions, "shape");
    const withDocs = (schemaValue: Record<string, unknown>): Record<string, unknown> => ({
      ...(shape.title ? { title: shape.title } : {}),
      ...(shape.docs?.description ? { description: shape.docs.description } : {}),
      ...schemaValue,
    });

    return Match.value(shape.node).pipe(
      Match.when({ type: "unknown" }, () => withDocs({})),
      Match.when({ type: "const" }, (node) => withDocs({ const: node.value })),
      Match.when({ type: "enum" }, (node) => withDocs({ enum: node.values })),
      Match.when({ type: "scalar" }, (node) =>
        withDocs({
          type: node.scalar === "bytes" ? "string" : node.scalar,
          ...(node.scalar === "bytes" ? { format: "binary" } : {}),
          ...(node.format ? { format: node.format } : {}),
          ...node.constraints,
        })),
      Match.when({ type: "ref" }, (node) =>
        shouldInlineRefTarget(node.target)
          ? buildInline(node.target, suggestions)
          : buildRef(node.target, suggestions)),
      Match.when({ type: "nullable" }, (node) =>
        withDocs({
          anyOf: [
            buildInline(node.itemShapeId, suggestions),
            { type: "null" },
          ],
        })),
      Match.when({ type: "allOf" }, (node) =>
        withDocs({
          allOf: node.items.map((entry, index) =>
            buildInline(entry, [`${label}_allOf_${String(index + 1)}`])),
        })),
      Match.when({ type: "anyOf" }, (node) =>
        withDocs({
          anyOf: node.items.map((entry, index) =>
            buildInline(entry, [`${label}_anyOf_${String(index + 1)}`])),
        })),
      Match.when({ type: "oneOf" }, (node) =>
        withDocs({
          oneOf: node.items.map((entry, index) =>
            buildInline(entry, [`${label}_option_${String(index + 1)}`])),
          ...(node.discriminator
            ? {
                discriminator: {
                  propertyName: node.discriminator.propertyName,
                  ...(node.discriminator.mapping
                    ? {
                        mapping: Object.fromEntries(
                          Object.entries(node.discriminator.mapping).map(([key, value]) => [
                            key,
                            buildRef(value, [key, `${label}_${key}`]).$ref,
                          ]),
                        ),
                      }
                    : {}),
                },
              }
            : {}),
        })),
      Match.when({ type: "not" }, (node) =>
        withDocs({
          not: buildInline(node.itemShapeId, [`${label}_not`]),
        })),
      Match.when({ type: "conditional" }, (node) =>
        withDocs({
          if: buildInline(node.ifShapeId, [`${label}_if`]),
          ...(node.thenShapeId
            ? { then: buildInline(node.thenShapeId, [`${label}_then`]) }
            : {}),
          ...(node.elseShapeId
            ? { else: buildInline(node.elseShapeId, [`${label}_else`]) }
            : {}),
        })),
      Match.when({ type: "array" }, (node) =>
        withDocs({
          type: "array",
          items: buildInline(node.itemShapeId, [`${label}_item`]),
          ...(node.minItems !== undefined ? { minItems: node.minItems } : {}),
          ...(node.maxItems !== undefined ? { maxItems: node.maxItems } : {}),
        })),
      Match.when({ type: "tuple" }, (node) =>
        withDocs({
          type: "array",
          prefixItems: node.itemShapeIds.map((entry, index) =>
            buildInline(entry, [`${label}_item_${String(index + 1)}`])),
          ...(node.additionalItems !== undefined
            ? {
                items:
                  typeof node.additionalItems === "boolean"
                    ? node.additionalItems
                    : buildInline(node.additionalItems, [`${label}_item_rest`]),
              }
            : {}),
        })),
      Match.when({ type: "map" }, (node) =>
        withDocs({
          type: "object",
          additionalProperties: buildInline(node.valueShapeId, [`${label}_value`]),
        })),
      Match.when({ type: "object" }, (node) =>
        withDocs({
          type: "object",
          properties: Object.fromEntries(
            Object.entries(node.fields).map(([key, field]) => [
              key,
              {
                ...buildInline(field.shapeId, [key]),
                ...(field.docs?.description ? { description: field.docs.description } : {}),
              },
            ]),
          ),
          ...(node.required && node.required.length > 0
            ? { required: node.required }
            : {}),
          ...(node.additionalProperties !== undefined
            ? {
                additionalProperties:
                  typeof node.additionalProperties === "boolean"
                    ? node.additionalProperties
                    : buildInline(node.additionalProperties, [`${label}_additionalProperty`]),
              }
            : {}),
          ...(node.patternProperties
            ? {
                patternProperties: Object.fromEntries(
                  Object.entries(node.patternProperties).map(([key, value]) => [
                    key,
                    buildInline(value, [`${label}_patternProperty`]),
                  ]),
                ),
              }
            : {}),
        })),
      Match.when({ type: "graphqlInterface" }, (node) =>
        withDocs({
          type: "object",
          properties: Object.fromEntries(
            Object.entries(node.fields).map(([key, field]) => [
              key,
              buildInline(field.shapeId, [key]),
            ]),
          ),
        })),
      Match.when({ type: "graphqlUnion" }, (node) =>
        withDocs({
          oneOf: node.memberTypeIds.map((entry, index) =>
            buildInline(entry, [`${label}_member_${String(index + 1)}`])),
        })),
      Match.exhaustive,
    );
  };

  const buildRootSchema = (
    shapeId: string,
    suggestions: readonly string[] = [],
  ): Record<string, unknown> => {
    const shape = asShape(catalog, shapeId);
    if (!shape) return {};
    return Match.value(shape.node).pipe(
      Match.when({ type: "ref" }, (node) => buildRootSchema(node.target, suggestions)),
      Match.orElse(() => buildInline(shapeId, suggestions)),
    );
  };

  const rootSchema = buildRootSchema(rootShapeId, ["input"]);
  return Object.keys(defs).length > 0
    ? { ...rootSchema, $defs: defs }
    : rootSchema;
};

// ---------------------------------------------------------------------------
// Projector helper
// ---------------------------------------------------------------------------

const projectorForProjectedCatalog = (projected: ProjectedCatalog): CatalogTypeProjector =>
  createCatalogTypeProjector({
    catalog: projected.catalog,
    roots: projectedCatalogTypeRoots(projected),
  });

// ---------------------------------------------------------------------------
// Descriptor builder
// ---------------------------------------------------------------------------

const codemodeDescriptorFromCapability = (input: {
  source: Source;
  projected: ProjectedCatalog;
  capability: Capability;
  executable: Executable;
  typeProjector: CatalogTypeProjector;
  includeSchemas: boolean;
  includeTypePreviews: boolean;
}): CatalogToolDescriptor => {
  const projectedDescriptor = input.projected.toolDescriptors[input.capability.id];
  const path = projectedDescriptor.toolPath.join(".");
  const interaction =
    projectedDescriptor.interaction.mayRequireApproval || projectedDescriptor.interaction.mayElicit
      ? "required"
      : "auto";
  const inputSchema = input.includeSchemas
    ? shapeToJsonSchema(input.projected.catalog, projectedDescriptor.callShapeId)
    : undefined;
  const rawOutputSchema =
    input.includeSchemas && projectedDescriptor.resultShapeId
      ? shapeToJsonSchema(input.projected.catalog, projectedDescriptor.resultShapeId)
      : undefined;
  const outputSchema = rawOutputSchema;
  const inputTypePreview = input.includeTypePreviews
    ? input.typeProjector.renderSelfContainedShape(
        projectedDescriptor.callShapeId,
        {
          aliasHint: joinTypeNameSegments(...projectedDescriptor.toolPath, "call"),
        },
      )
    : undefined;
  const outputTypePreview = input.includeTypePreviews && projectedDescriptor.resultShapeId
    ? input.typeProjector.renderSelfContainedShape(projectedDescriptor.resultShapeId, {
        aliasHint: joinTypeNameSegments(...projectedDescriptor.toolPath, "result"),
      })
    : undefined;

  return {
    path: path as CatalogToolDescriptor["path"],
    sourceKey: input.source.id,
    description: input.capability.surface.summary ?? input.capability.surface.description,
    interaction,
    contract: {
      inputTypePreview,
      ...(outputTypePreview !== undefined ? { outputTypePreview } : {}),
      ...(inputSchema !== undefined ? { inputSchema } : {}),
      ...(outputSchema !== undefined ? { outputSchema } : {}),
    },
    providerKind: input.executable.adapterKey,
    providerData: {
      capabilityId: input.capability.id,
      executableId: input.executable.id,
      adapterKey: input.executable.adapterKey,
      display: input.executable.display,
    },
  };
};

// ---------------------------------------------------------------------------
// Tool from capability
// ---------------------------------------------------------------------------

const loadedCatalogToolFromCapability = (input: {
  catalogEntry: LoadedSourceCatalog;
  capability: Capability;
  includeSchemas: boolean;
  includeTypePreviews: boolean;
}): LoadedSourceCatalogTool => {
  const executable = chooseExecutable(input.catalogEntry.projected.catalog, input.capability);
  const projectedDescriptor = input.catalogEntry.projected.toolDescriptors[input.capability.id];
  const descriptor = codemodeDescriptorFromCapability({
    source: input.catalogEntry.source,
    projected: input.catalogEntry.projected,
    capability: input.capability,
    executable,
    typeProjector: input.catalogEntry.typeProjector,
    includeSchemas: input.includeSchemas,
    includeTypePreviews: input.includeTypePreviews,
  });
  const path = descriptorPath(descriptor);
  const searchDoc = input.catalogEntry.projected.searchDocs[input.capability.id];
  const searchNamespace = catalogNamespaceFromPath(path);
  const searchText = [
    path,
    searchNamespace,
    input.catalogEntry.source.name,
    input.capability.surface.title,
    input.capability.surface.summary,
    input.capability.surface.description,
    descriptor.contract?.inputTypePreview,
    descriptor.contract?.outputTypePreview,
    ...(searchDoc?.tags ?? []),
    ...(searchDoc?.protocolHints ?? []),
    ...(searchDoc?.authHints ?? []),
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ")
    .toLowerCase();

  return {
    path,
    searchNamespace,
    searchText,
    source: input.catalogEntry.source,
    revision: input.catalogEntry.revision,
    capabilityId: input.capability.id,
    executableId: executable.id,
    capability: input.capability,
    executable,
    projectedDescriptor,
    descriptor,
    projectedCatalog: input.catalogEntry.projected.catalog,
    typeProjector: input.catalogEntry.typeProjector,
  } satisfies LoadedSourceCatalogTool;
};

// ---------------------------------------------------------------------------
// Public: loadSourceWithCatalog
// ---------------------------------------------------------------------------

type SourceCatalogRuntimeServices =
  | RuntimeLocalWorkspace
  | SourceStore
  | WorkspaceDatabase;

export const loadSourceWithCatalog = (input: {
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
}): Effect.Effect<
  LoadedSourceCatalog,
  Error | LocalSourceArtifactMissingError,
  SourceCatalogRuntimeServices
> =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* RuntimeLocalWorkspace;
    const sourceStore = yield* SourceStore;
    const workspaceDatabase = yield* WorkspaceDatabase;

    if (runtimeLocalWorkspace.installation.workspaceId !== input.workspaceId) {
      return yield* runtimeEffectError(
        "catalog/source/runtime",
        `Runtime local workspace mismatch: expected ${input.workspaceId}, got ${runtimeLocalWorkspace.installation.workspaceId}`,
      );
    }

    return yield* loadSourceWithCatalogFromDb({ sourceId: input.sourceId as SourceId }).pipe(
      Effect.provide(workspaceDatabase.queryLayer()),
      Effect.provideService(SourceStore, sourceStore),
      Effect.mapError((e) =>
        e instanceof LocalSourceArtifactMissingError || e instanceof Error
          ? e
          : new Error(String(e))),
    );
  });

// ---------------------------------------------------------------------------
// DB-backed catalog loading
// ---------------------------------------------------------------------------

const loadSourceWithCatalogFromDb = (input: {
  sourceId: SourceId;
}): Effect.Effect<
  LoadedSourceCatalog,
  Error | LocalSourceArtifactMissingError,
  SqliteDrizzle | SourceStore
> =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle;
    const sourceStore = yield* SourceStore;

    // 1. Load source row from DB
    const sourceRows = yield* db
      .select()
      .from(sourceTable)
      .where(eq(sourceTable.id, input.sourceId))
      .limit(1);
    if (sourceRows.length === 0) {
      return yield* new LocalSourceArtifactMissingError({
        message: `Source not found in DB: ${input.sourceId}`,
        sourceId: input.sourceId,
      });
    }
    const sourceRow = sourceRows[0];
    const source = yield* sourceStore.loadSourceById({
      workspaceId: sourceRow.workspaceId as WorkspaceId,
      sourceId: input.sourceId,
    });

    // 2. Find the latest catalog_revision
    const catalogId = sourceRow.catalogId;
    const revisionId = sourceRow.catalogRevisionId;
    if (!catalogId || !revisionId) {
      return yield* new LocalSourceArtifactMissingError({
        message: `Catalog artifact missing for source ${input.sourceId}`,
        sourceId: input.sourceId,
      });
    }

    const revisionRows = yield* db
      .select()
      .from(catalog_revision)
      .where(eq(catalog_revision.id, revisionId as SourceCatalogRevisionId))
      .limit(1);
    if (revisionRows.length === 0 || !revisionRows[0].snapshotJson) {
      return yield* new LocalSourceArtifactMissingError({
        message: `Catalog artifact missing for source ${input.sourceId}`,
        sourceId: input.sourceId,
      });
    }
    const revisionRow = revisionRows[0];

    // 3. Parse snapshot_json
    const rawSnapshotJson = revisionRow.snapshotJson!;
    const snapshotPartial = (typeof rawSnapshotJson === "string"
      ? JSON.parse(rawSnapshotJson)
      : rawSnapshotJson) as Record<string, unknown>;

    // 4. Load all catalog_tool rows for this source
    const toolRows = yield* db
      .select()
      .from(catalog_tool)
      .where(eq(catalog_tool.sourceId, input.sourceId));

    // 5. Reconstruct capabilities and executables
    const capabilities: Record<string, Capability> = {};
    const executables: Record<string, Executable> = {};
    for (const row of toolRows) {
      if (row.capabilityJson) {
        const capability = (typeof row.capabilityJson === "string"
          ? JSON.parse(row.capabilityJson)
          : row.capabilityJson) as Capability;
        capabilities[capability.id] = capability;
      }
      if (row.executableJson) {
        const executable = (typeof row.executableJson === "string"
          ? JSON.parse(row.executableJson)
          : row.executableJson) as Executable;
        executables[executable.id] = executable;
      }
    }

    // 6. Load documents from catalog_document
    const docRows = yield* db
      .select()
      .from(catalog_document)
      .where(eq(catalog_document.revisionId, revisionId as SourceCatalogRevisionId));

    const documents: Record<string, unknown> = {};
    for (const doc of docRows) {
      try {
        documents[doc.documentId] = JSON.parse(doc.content);
      } catch {
        documents[doc.documentId] = { content: doc.content };
      }
    }

    // 7. Assemble the full CatalogV1
    const catalogV1: CatalogV1 = {
      version: "ir.v1",
      documents: documents as CatalogV1["documents"],
      resources: (snapshotPartial.resources ?? {}) as CatalogV1["resources"],
      scopes: (snapshotPartial.scopes ?? {}) as CatalogV1["scopes"],
      symbols: (snapshotPartial.symbols ?? {}) as CatalogV1["symbols"],
      capabilities: capabilities as CatalogV1["capabilities"],
      executables: executables as CatalogV1["executables"],
      responseSets: (snapshotPartial.responseSets ?? {}) as CatalogV1["responseSets"],
      diagnostics: (snapshotPartial.diagnostics ?? {}) as CatalogV1["diagnostics"],
    };

    // 8. Project the catalog
    const projected = projectCatalogForAgentSdk({ catalog: catalogV1 });
    const typeProjector = projectorForProjectedCatalog(projected);

    // 9. Build the revision record
    const revision: StoredSourceCatalogRevisionRecord = {
      id: revisionRow.id as SourceCatalogRevisionId,
      catalogId: revisionRow.catalogId as SourceCatalogId,
      revisionNumber: revisionRow.revisionNumber,
      sourceConfigJson: revisionRow.sourceConfigJson
        ? (typeof revisionRow.sourceConfigJson === "string"
            ? revisionRow.sourceConfigJson
            : JSON.stringify(revisionRow.sourceConfigJson))
        : "{}",
      importMetadataJson: revisionRow.importMetadataJson
        ? (typeof revisionRow.importMetadataJson === "string"
            ? revisionRow.importMetadataJson
            : JSON.stringify(revisionRow.importMetadataJson))
        : null,
      importMetadataHash: revisionRow.importMetadataHash ?? null,
      snapshotHash: revisionRow.snapshotHash ?? null,
      createdAt: revisionRow.createdAt ?? Date.now(),
      updatedAt: revisionRow.updatedAt ?? Date.now(),
    };

    // 10. Build import metadata
    const importMetadata: CatalogImportMetadata = revisionRow.importMetadataJson
      ? (typeof revisionRow.importMetadataJson === "string"
          ? JSON.parse(revisionRow.importMetadataJson)
          : revisionRow.importMetadataJson) as CatalogImportMetadata
      : { capabilities: {} } as unknown as CatalogImportMetadata;

    return {
      source,
      revision,
      snapshot: {
        version: "ir.v1.snapshot",
        import: importMetadata,
        catalog: catalogV1,
      } as CatalogSnapshotV1,
      catalog: catalogV1,
      projected,
      typeProjector,
      importMetadata,
    } satisfies LoadedSourceCatalog;
  });

// ---------------------------------------------------------------------------
// Public: expandCatalogTools
// ---------------------------------------------------------------------------

export const expandCatalogTools = (input: {
  catalogs: readonly LoadedSourceCatalog[];
  includeSchemas: boolean;
  includeTypePreviews?: boolean;
}): Effect.Effect<readonly LoadedSourceCatalogTool[], Error, never> =>
  Effect.succeed(
    input.catalogs.flatMap((catalogEntry) =>
      Object.values(catalogEntry.catalog.capabilities).map((capability) =>
        loadedCatalogToolFromCapability({
          catalogEntry,
          capability,
          includeSchemas: input.includeSchemas,
          includeTypePreviews: input.includeTypePreviews ?? true,
        })),
    ),
  );

// ---------------------------------------------------------------------------
// Public: expandCatalogToolByPath
// ---------------------------------------------------------------------------

export const expandCatalogToolByPath = (input: {
  catalogs: readonly LoadedSourceCatalog[];
  path: string;
  includeSchemas: boolean;
  includeTypePreviews?: boolean;
}): Effect.Effect<LoadedSourceCatalogTool | null, Error, never> =>
  Effect.succeed(
    input.catalogs
      .flatMap((catalogEntry) =>
        Object.values(catalogEntry.catalog.capabilities).flatMap((capability) => {
          return projectedToolPath(catalogEntry.projected, capability) === input.path
            ? [
                loadedCatalogToolFromCapability({
                  catalogEntry,
                  capability,
                  includeSchemas: input.includeSchemas,
                  includeTypePreviews: input.includeTypePreviews ?? true,
                }),
              ]
            : [];
        }))
      .at(0) ?? null,
  );

// ---------------------------------------------------------------------------
// Public: buildLoadedSourceCatalogToolContract
// ---------------------------------------------------------------------------

const declarationBlockForShape = (input: {
  catalog: CatalogV1;
  shapeId: ShapeSymbolId;
  aliasHint: string;
}): Effect.Effect<string, Error, never> =>
  Effect.tryPromise({
    try: async () => {
      const projector = createCatalogTypeProjector({
        catalog: input.catalog,
        roots: [{
          shapeId: input.shapeId,
          aliasHint: input.aliasHint,
        }],
      });
      const rootType = projector.renderDeclarationShape(input.shapeId, {
        aliasHint: input.aliasHint,
      });
      const supportingDeclarations = projector.supportingDeclarations();
      const rootDeclarationPrefix = `type ${input.aliasHint} =`;
      const declarationText = supportingDeclarations.some((declaration) =>
        declaration.includes(rootDeclarationPrefix)
      )
        ? supportingDeclarations.join("\n\n")
        : [
            ...supportingDeclarations,
            typeAliasDeclaration({
              catalog: input.catalog,
              shapeId: input.shapeId,
              aliasHint: input.aliasHint,
              body: rootType,
            }),
          ].join("\n\n");

      return formatWithPrettier(declarationText, "typescript-module");
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  });

const formattedOptionalTypeExpression = (
  value: string | undefined,
): Effect.Effect<string | null, Error, never> =>
  value === undefined
    ? Effect.succeed(null)
    : Effect.tryPromise({
        try: () => formatWithPrettier(value, "typescript"),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      });

const formattedOptionalJson = (
  value: unknown,
): Effect.Effect<string | null, Error, never> => {
  const serialized = optionalJsonString(value);
  return serialized === null
    ? Effect.succeed(null)
    : Effect.tryPromise({
        try: () => formatWithPrettier(serialized, "json"),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      });
};

const lowerCamelCase = (value: string): string =>
  value.length === 0 ? "tool" : `${value.slice(0, 1).toLowerCase()}${value.slice(1)}`;

const typeAliasDeclaration = (input: {
  catalog: CatalogV1;
  shapeId: ShapeSymbolId;
  aliasHint: string;
  body: string;
}): string => {
  const shape = input.catalog.symbols[input.shapeId];
  const comment = shape?.kind === "shape"
    ? documentationComment({
        title: shape.title,
        docs: shape.docs,
        deprecated: shape.deprecated,
        includeTitle: true,
      })
    : null;
  const declaration = `type ${input.aliasHint} = ${input.body};`;
  return comment ? `${comment}\n${declaration}` : declaration;
};

export const buildLoadedSourceCatalogToolContract = (
  tool: LoadedSourceCatalogTool,
): Effect.Effect<LoadedSourceCatalogToolContract, Error, never> => {
  const inputAlias = joinTypeNameSegments(...tool.projectedDescriptor.toolPath, "call");
  const outputAlias = joinTypeNameSegments(...tool.projectedDescriptor.toolPath, "result");
  const inputShapeId = tool.projectedDescriptor.callShapeId;
  const outputShapeId = tool.projectedDescriptor.resultShapeId ?? null;
  const argsOptional = shapeAllowsOmittedArgs(tool.projectedCatalog, inputShapeId);
  const outputTypeName = outputShapeId ? outputAlias : "unknown";
  const callFunctionName = lowerCamelCase(
    joinTypeNameSegments(...tool.projectedDescriptor.toolPath),
  );
  const callComment = documentationComment({
    title: tool.capability.surface.title,
    docs: {
      ...(tool.capability.surface.summary
        ? { summary: tool.capability.surface.summary }
        : {}),
      ...(tool.capability.surface.description
        ? { description: tool.capability.surface.description }
        : {}),
    },
    includeTitle: true,
  });

  return Effect.gen(function* () {
    const [
      inputTypePreview,
      outputTypePreview,
      inputTypeDeclaration,
      outputTypeDeclaration,
      inputSchemaJson,
      outputSchemaJson,
      callSignature,
      callDeclaration,
    ] =
      yield* Effect.all([
        formattedOptionalTypeExpression(tool.descriptor.contract?.inputTypePreview),
        formattedOptionalTypeExpression(tool.descriptor.contract?.outputTypePreview),
        declarationBlockForShape({
          catalog: tool.projectedCatalog,
          shapeId: inputShapeId,
          aliasHint: inputAlias,
        }),
        outputShapeId
          ? declarationBlockForShape({
              catalog: tool.projectedCatalog,
              shapeId: outputShapeId,
              aliasHint: outputAlias,
            })
          : Effect.succeed<string | null>(null),
        formattedOptionalJson(
          tool.descriptor.contract?.inputSchema
          ?? shapeToJsonSchema(tool.projectedCatalog, inputShapeId),
        ),
        outputShapeId
          ? formattedOptionalJson(
              tool.descriptor.contract?.outputSchema
              ?? shapeToJsonSchema(tool.projectedCatalog, outputShapeId),
            )
          : Effect.succeed<string | null>(null),
        Effect.tryPromise({
          try: () =>
            formatWithPrettier(
              `(${argsOptional ? "args?" : "args"}: ${inputAlias}) => Promise<${outputTypeName}>`,
              "typescript",
            ),
          catch: (cause) =>
            cause instanceof Error ? cause : new Error(String(cause)),
        }),
        Effect.tryPromise({
          try: () =>
            formatWithPrettier(
              [
                ...(callComment ? [callComment] : []),
                `declare function ${callFunctionName}(${argsOptional ? "args?" : "args"}: ${inputAlias}): Promise<${outputTypeName}>;`,
              ].join("\n"),
              "typescript-module",
            ),
          catch: (cause) =>
            cause instanceof Error ? cause : new Error(String(cause)),
        }),
      ]);

    return {
      callSignature,
      callDeclaration,
      callShapeId: inputShapeId,
      resultShapeId: outputShapeId,
      responseSetId: tool.projectedDescriptor.responseSetId,
      input: {
        shapeId: inputShapeId,
        typePreview: inputTypePreview,
        typeDeclaration: inputTypeDeclaration,
        schemaJson: inputSchemaJson,
        exampleJson: null,
      },
      output: {
        shapeId: outputShapeId,
        typePreview: outputTypePreview,
        typeDeclaration: outputTypeDeclaration,
        schemaJson: outputSchemaJson,
        exampleJson: null,
      },
    } satisfies LoadedSourceCatalogToolContract;
  });
};
