import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

import type {
  SourceCatalogKind,
  SourceCatalogId,
  SourceCatalogRevisionId,
  SourceCatalogVisibility,
} from "@executor/core/model"

import { Timestamps } from "../schema.sql"

export const catalog = sqliteTable("catalog", {
  id:               text().$type<SourceCatalogId>().primaryKey(),
  kind:             text().$type<SourceCatalogKind>().notNull(),
  adapterKey:       text("adapter_key").notNull(),
  providerKey:      text("provider_key").notNull(),
  name:             text().notNull(),
  summary:          text(),
  visibility:       text().$type<SourceCatalogVisibility>().notNull().default("private"),
  latestRevisionId: text("latest_revision_id").$type<SourceCatalogRevisionId | null>(),
  ...Timestamps,
})

export const catalog_revision = sqliteTable("catalog_revision", {
  id:                 text().$type<SourceCatalogRevisionId>().primaryKey(),
  catalogId:          text("catalog_id").$type<SourceCatalogId>().notNull()
                           .references(() => catalog.id, { onDelete: "cascade" }),
  revisionNumber:     integer("revision_number").notNull(),
  sourceConfigJson:   text("source_config_json", { mode: "json" }),
  importMetadataJson: text("import_metadata_json", { mode: "json" }),
  importMetadataHash: text("import_metadata_hash"),
  snapshotHash:       text("snapshot_hash"),
  snapshotJson:       text("snapshot_json"),
  ...Timestamps,
}, (table) => [
  index("catalog_revision_catalog_idx").on(table.catalogId),
])
