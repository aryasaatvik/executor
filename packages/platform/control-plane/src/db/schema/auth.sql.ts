import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../schema.sql"

export const auth_artifact = sqliteTable("auth_artifact", {
  id:                  text().primaryKey(),
  workspace_id:        text().notNull(),
  source_id:           text().notNull(), // FK: source.id (added in migration)
  actor_account_id:    text(),
  slot:                text().notNull(),
  artifact_kind:       text().notNull(),
  config_json:         text({ mode: "json" }).notNull(),
  grant_set_json:      text({ mode: "json" }),
  ...Timestamps,
}, (table) => [
  index("auth_artifact_source_idx").on(table.workspace_id, table.source_id),
  index("auth_artifact_slot_idx").on(table.workspace_id, table.source_id, table.slot),
])

export const auth_lease = sqliteTable("auth_lease", {
  id:                        text().primaryKey(),
  auth_artifact_id:          text().notNull()
                               .references(() => auth_artifact.id, { onDelete: "cascade" }),
  workspace_id:              text().notNull(),
  source_id:                 text().notNull(),
  actor_account_id:          text(),
  slot:                      text().notNull(),
  placements_template_json:  text({ mode: "json" }).notNull(),
  expires_at:                integer(),
  refresh_after:             integer(),
  ...Timestamps,
}, (table) => [
  index("auth_lease_artifact_idx").on(table.auth_artifact_id),
  index("auth_lease_source_idx").on(table.workspace_id, table.source_id),
])
