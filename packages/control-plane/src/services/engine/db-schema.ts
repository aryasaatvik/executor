// Drizzle table definitions — copied from @executor/engine/src/db/schema/
// These are the workspace catalog SQLite tables used by control-plane services.
import type { SourceCatalogRevisionId } from "../../model/index";
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Timestamps helper — copied from @executor/engine/src/db/schema.sql.ts
const Timestamps = {
  createdAt: integer("created_at")
    .notNull()
    .$default(() => Date.now()),
  updatedAt: integer("updated_at")
    .notNull()
    .$onUpdate(() => Date.now()),
};

// Source table — from @executor/engine/src/db/schema/source.sql.ts
export const source = sqliteTable(
  "source",
  {
    id: text().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    catalogId: text("catalog_id"),
    catalogRevisionId: text("catalog_revision_id"),
    status: text().notNull().default("draft"),
    enabled: integer({ mode: "boolean" }).notNull().default(true),
    sourceHash: text("source_hash"),
    lastError: text("last_error"),
    ...Timestamps,
  },
  (table) => [
    index("source_workspace_idx").on(table.workspaceId),
    index("source_status_idx").on(table.workspaceId, table.status),
  ],
);

// Policy table — from @executor/engine/src/db/schema/policy.sql.ts
export const policy = sqliteTable(
  "policy",
  {
    id: text().primaryKey(),
    slug: text().notNull(),
    workspaceId: text("workspace_id").notNull(),
    resourcePattern: text("resource_pattern").notNull(),
    effect: text().notNull(),
    approvalMode: text("approval_mode").notNull(),
    priority: integer().notNull(),
    enabled: integer({ mode: "boolean" }).notNull().default(true),
    ...Timestamps,
  },
  (table) => [
    index("policy_workspace_idx").on(table.workspaceId),
    uniqueIndex("policy_workspace_slug_idx").on(table.workspaceId, table.slug),
  ],
);

// Catalog tool table — from @executor/engine/src/db/schema/catalog-tool.sql.ts
export const catalog_tool = sqliteTable(
  "catalog_tool",
  {
    toolId: text("tool_id").primaryKey(),
    path: text().notNull(),
    sourceId: text("source_id")
      .notNull()
      .references(() => source.id, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull(),
    namespace: text().notNull(),
    title: text(),
    description: text(),
    searchText: text("search_text").notNull(),
    inputSchemaJson: text("input_schema_json", { mode: "json" }),
    outputSchemaJson: text("output_schema_json", { mode: "json" }),
    inputTypePreview: text("input_type_preview"),
    outputTypePreview: text("output_type_preview"),
    interaction: text().default("auto"),
    providerKind: text("provider_kind"),
    contentHash: text("content_hash").notNull(),
    sourceEnabled: integer("source_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    sourceStatus: text("source_status").default("connected"),
    capabilityJson: text("capability_json"),
    executableJson: text("executable_json"),
    ...Timestamps,
  },
  (table) => [
    index("idx_tool_source").on(table.sourceId),
    index("idx_tool_namespace").on(table.namespace),
    index("idx_tool_path").on(table.path),
  ],
);

// Catalog table — from @executor/engine/src/db/schema/source-catalog.sql.ts
export const catalog = sqliteTable("catalog", {
  id: text().primaryKey(),
  kind: text().notNull(),
  adapterKey: text("adapter_key").notNull(),
  providerKey: text("provider_key").notNull(),
  name: text().notNull(),
  summary: text(),
  visibility: text().notNull().default("private"),
  latestRevisionId: text("latest_revision_id"),
  ...Timestamps,
});

// Catalog revision table — from @executor/engine/src/db/schema/source-catalog.sql.ts
export const catalog_revision = sqliteTable(
  "catalog_revision",
  {
    id: text().primaryKey(),
    catalogId: text("catalog_id")
      .notNull()
      .references(() => catalog.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    sourceConfigJson: text("source_config_json", { mode: "json" }),
    importMetadataJson: text("import_metadata_json", { mode: "json" }),
    importMetadataHash: text("import_metadata_hash"),
    snapshotHash: text("snapshot_hash"),
    snapshotJson: text("snapshot_json"),
    ...Timestamps,
  },
  (table) => [
    index("catalog_revision_catalog_idx").on(table.catalogId),
  ],
);

// Catalog document table — from @executor/engine/src/db/schema/catalog-document.sql.ts
export const catalog_document = sqliteTable("catalog_document", {
  id: text().primaryKey(),
  revisionId: text("revision_id").$type<SourceCatalogRevisionId>().notNull()
    .references(() => catalog_revision.id, { onDelete: "cascade" }),
  documentId: text("document_id").notNull(),
  content: text().notNull(),
  createdAt: integer("created_at").notNull().$default(() => Date.now()),
}, (table) => [
  uniqueIndex("catalog_document_revision_document_idx").on(table.revisionId, table.documentId),
]);
