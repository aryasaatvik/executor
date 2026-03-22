import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../schema.sql"

export const execution = sqliteTable("execution", {
  id:                    text().primaryKey(),
  workspace_id:          text().notNull(),
  created_by_account_id: text().notNull(),
  status:                text().notNull().default("pending"),
  code:                  text().notNull(),
  result_json:           text({ mode: "json" }),
  error_text:            text(),
  logs_json:             text({ mode: "json" }),
  started_at:            integer(),
  completed_at:          integer(),
  ...Timestamps,
}, (table) => [
  index("execution_workspace_idx").on(table.workspace_id),
  index("execution_status_idx").on(table.workspace_id, table.status),
])

export const execution_interaction = sqliteTable("execution_interaction", {
  id:                    text().primaryKey(),
  execution_id:          text().notNull()
                           .references(() => execution.id, { onDelete: "cascade" }),
  status:                text().notNull().default("pending"),
  kind:                  text().notNull(),
  purpose:               text().notNull(),
  payload_json:          text({ mode: "json" }).notNull(),
  response_json:         text({ mode: "json" }),
  response_private_json: text({ mode: "json" }),
  ...Timestamps,
}, (table) => [
  index("interaction_execution_idx").on(table.execution_id),
])

export const execution_step = sqliteTable("execution_step", {
  id:              text().primaryKey(),
  execution_id:    text().notNull()
                     .references(() => execution.id, { onDelete: "cascade" }),
  sequence:        integer().notNull(),
  kind:            text().notNull(),
  status:          text().notNull().default("pending"),
  path:            text().notNull(),
  args_json:       text({ mode: "json" }).notNull(),
  result_json:     text({ mode: "json" }),
  error_text:      text(),
  interaction_id:  text(),
  ...Timestamps,
}, (table) => [
  index("step_execution_idx").on(table.execution_id),
  index("step_execution_seq_idx").on(table.execution_id, table.sequence),
])
