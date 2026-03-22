import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../schema.sql"

export const source_auth_session = sqliteTable("source_auth_session", {
  id:                text().primaryKey(),
  workspace_id:      text().notNull(),
  source_id:         text().notNull(), // FK: source.id (added in migration)
  actor_account_id:  text(),
  credential_slot:   text().notNull(),
  execution_id:      text(),
  interaction_id:    text(),
  provider_kind:     text().notNull(),
  status:            text().notNull().default("pending"),
  state:             text().notNull(),
  session_data_json: text({ mode: "json" }).notNull(),
  error_text:        text(),
  completed_at:      integer(),
  ...Timestamps,
}, (table) => [
  index("auth_session_source_idx").on(table.workspace_id, table.source_id),
  index("auth_session_status_idx").on(table.status),
])
