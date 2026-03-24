import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"

import type {
  LocalWorkspacePolicyApprovalMode,
  LocalWorkspacePolicyEffect,
  PolicyId,
  WorkspaceId,
} from "#schema";

import { Timestamps } from "../schema.sql"

export const policy = sqliteTable("policy", {
  id:              text().$type<PolicyId>().primaryKey(),
  slug:            text().notNull(),
  workspaceId:     text("workspace_id").$type<WorkspaceId>().notNull(),
  resourcePattern: text("resource_pattern").notNull(),
  effect:          text().$type<LocalWorkspacePolicyEffect>().notNull(),
  approvalMode:    text("approval_mode").$type<LocalWorkspacePolicyApprovalMode>().notNull(),
  priority:        integer().notNull(),
  enabled:         integer({ mode: "boolean" }).notNull().default(true),
  ...Timestamps,
}, (table) => [
  index("policy_workspace_idx").on(table.workspaceId),
  uniqueIndex("policy_workspace_slug_idx").on(table.workspaceId, table.slug),
])
