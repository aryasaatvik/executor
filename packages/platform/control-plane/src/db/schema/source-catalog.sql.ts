import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../schema.sql"

export const source_catalog = sqliteTable("source_catalog", {
  id:                    text().primaryKey(),
  kind:                  text().notNull(),
  adapter_key:           text().notNull(),
  provider_key:          text().notNull(),
  name:                  text().notNull(),
  summary:               text(),
  visibility:            text().notNull().default("private"),
  latest_revision_id:    text(),
  ...Timestamps,
})

export const source_catalog_revision = sqliteTable("source_catalog_revision", {
  id:                    text().primaryKey(),
  catalog_id:            text().notNull()
                           .references(() => source_catalog.id, { onDelete: "cascade" }),
  revision_number:       integer().notNull(),
  source_config_json:    text({ mode: "json" }),
  import_metadata_json:  text({ mode: "json" }),
  import_metadata_hash:  text(),
  snapshot_hash:         text(),
  ...Timestamps,
}, (table) => [
  index("catalog_revision_catalog_idx").on(table.catalog_id),
])
