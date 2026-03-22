import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../schema.sql"

export const source = sqliteTable("source", {
  id:                  text().primaryKey(),
  workspace_id:        text().notNull(),
  catalog_id:          text(),
  catalog_revision_id: text(),
  name:                text().notNull(),
  kind:                text().notNull(),
  endpoint:            text().notNull(),
  status:              text().notNull().default("draft"),
  enabled:             integer({ mode: "boolean" }).notNull().default(true),
  namespace:           text(),
  icon_url:            text(),
  import_auth_policy:  text({ mode: "json" }),
  binding_config_json: text({ mode: "json" }),
  binding_version:     integer(),
  source_hash:         text(),
  last_error:          text(),
  ...Timestamps,
}, (table) => [
  index("source_workspace_idx").on(table.workspace_id),
  index("source_status_idx").on(table.workspace_id, table.status),
])
