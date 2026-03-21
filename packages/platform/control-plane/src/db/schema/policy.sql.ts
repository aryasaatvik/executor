import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../schema.sql"

export const policy = sqliteTable("policy", {
  id:               text().primaryKey(),
  key:              text().notNull(),
  workspace_id:     text().notNull(),
  resource_pattern: text().notNull(),
  effect:           text().notNull(),
  approval_mode:    text().notNull(),
  priority:         integer().notNull(),
  enabled:          integer({ mode: "boolean" }).notNull().default(true),
  ...Timestamps,
}, (table) => [
  index("policy_workspace_idx").on(table.workspace_id),
])
