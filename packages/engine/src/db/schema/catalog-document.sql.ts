import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core"

import type { SourceCatalogRevisionId } from "#schema"

import { catalog_revision } from "./source-catalog.sql"

export const catalog_document = sqliteTable("catalog_document", {
  id:         text().primaryKey(),
  revisionId: text("revision_id").$type<SourceCatalogRevisionId>().notNull()
                   .references(() => catalog_revision.id, { onDelete: "cascade" }),
  documentId: text("document_id").notNull(),
  content:    text().notNull(),
  createdAt:  integer("created_at").notNull().$default(() => Date.now()),
}, (table) => [
  uniqueIndex("catalog_document_revision_document_idx").on(table.revisionId, table.documentId),
])
