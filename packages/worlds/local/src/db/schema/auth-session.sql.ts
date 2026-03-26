import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

import type {
  AccountId,
  ExecutionId,
  ExecutionInteractionId,
  SourceAuthSessionId,
  SourceId,
  WorkspaceId,
} from "@executor/control-plane/model"

import type {
  CredentialSlot,
  SourceAuthSessionProviderKind,
  SourceAuthSessionStatus,
} from "../types"

import { Timestamps } from "../schema.sql"

export const source_auth_session = sqliteTable("source_auth_session", {
  id:              text().$type<SourceAuthSessionId>().primaryKey(),
  workspaceId:     text("workspace_id").$type<WorkspaceId>().notNull(),
  sourceId:        text("source_id").$type<SourceId>().notNull(), // FK: source.id (added in migration)
  actorAccountId:  text("actor_account_id").$type<AccountId | null>(),
  credentialSlot:  text("credential_slot").$type<CredentialSlot>().notNull(),
  executionId:     text("execution_id").$type<ExecutionId | null>(),
  interactionId:   text("interaction_id").$type<ExecutionInteractionId | null>(),
  providerKind:    text("provider_kind").$type<SourceAuthSessionProviderKind>().notNull(),
  status:          text().$type<SourceAuthSessionStatus>().notNull().default("pending"),
  state:           text().notNull(),
  sessionDataJson: text("session_data_json", { mode: "json" }).notNull(),
  errorText:       text("error_text"),
  completedAt:     integer("completed_at"),
  ...Timestamps,
}, (table) => [
  index("auth_session_source_idx").on(table.workspaceId, table.sourceId),
  index("auth_session_status_idx").on(table.status),
])
