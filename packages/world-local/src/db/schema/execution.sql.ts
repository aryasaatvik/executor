import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

import type {
  AccountId,
  ExecutionId,
  ExecutionInteractionId,
  ExecutionInteractionStatus,
  ExecutionSessionId,
  ExecutionStatus,
  ExecutionStepId,
  ExecutionStepKind,
  ExecutionStepStatus,
  WorkspaceId,
} from "@executor/core/model"

import { Timestamps } from "../schema.sql"

export const execution = sqliteTable("execution", {
  id:                 text().$type<ExecutionId>().primaryKey(),
  workspaceId:        text("workspace_id").$type<WorkspaceId>().notNull(),
  createdByAccountId: text("created_by_account_id").$type<AccountId>().notNull(),
  executionSessionId: text("execution_session_id").$type<ExecutionSessionId | null>(),
  status:             text().$type<ExecutionStatus>().notNull().default("pending"),
  code:               text().notNull(),
  resultJson:         text("result_json", { mode: "json" }),
  errorText:          text("error_text"),
  logsJson:           text("logs_json", { mode: "json" }),
  startedAt:          integer("started_at"),
  completedAt:        integer("completed_at"),
  ...Timestamps,
}, (table) => [
  index("execution_workspace_idx").on(table.workspaceId),
  index("execution_status_idx").on(table.workspaceId, table.status),
])

export const execution_interaction = sqliteTable("execution_interaction", {
  id:                  text().$type<ExecutionInteractionId>().primaryKey(),
  executionId:         text("execution_id").$type<ExecutionId>().notNull()
                           .references(() => execution.id, { onDelete: "cascade" }),
  status:              text().$type<ExecutionInteractionStatus>().notNull().default("pending"),
  kind:                text().notNull(),
  purpose:             text().notNull(),
  payloadJson:         text("payload_json", { mode: "json" }).notNull(),
  responseJson:        text("response_json", { mode: "json" }),
  responsePrivateJson: text("response_private_json", { mode: "json" }),
  ...Timestamps,
}, (table) => [
  index("interaction_execution_idx").on(table.executionId),
])

export const execution_step = sqliteTable("execution_step", {
  id:             text().$type<ExecutionStepId>().primaryKey(),
  executionId:    text("execution_id").$type<ExecutionId>().notNull()
                     .references(() => execution.id, { onDelete: "cascade" }),
  sequence:       integer().notNull(),
  kind:           text().$type<ExecutionStepKind>().notNull(),
  status:         text().$type<ExecutionStepStatus>().notNull().default("pending"),
  path:           text().notNull(),
  argsJson:       text("args_json", { mode: "json" }).notNull(),
  resultJson:     text("result_json", { mode: "json" }),
  errorText:      text("error_text"),
  interactionId:  text("interaction_id").$type<ExecutionInteractionId | null>(),
  ...Timestamps,
}, (table) => [
  index("step_execution_idx").on(table.executionId),
  index("step_execution_seq_idx").on(table.executionId, table.sequence),
])
