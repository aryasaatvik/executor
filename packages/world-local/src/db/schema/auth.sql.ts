import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

import type {
  AccountId,
  AuthArtifact,
  AuthArtifactId,
  AuthArtifactKind,
  AuthArtifactSlot,
  AuthLease,
  AuthLeaseId,
  SourceId,
  WorkspaceId,
} from "@executor/core/model"

import { Timestamps } from "../schema.sql"

export const auth_artifact = sqliteTable("auth_artifact", {
  id:             text().$type<AuthArtifactId>().primaryKey(),
  workspaceId:    text("workspace_id").$type<WorkspaceId>().notNull(),
  sourceId:       text("source_id").$type<SourceId>().notNull(), // FK: source.id (added in migration)
  actorAccountId: text("actor_account_id").$type<AccountId | null>(),
  slot:           text().$type<AuthArtifactSlot>().notNull(),
  artifactKind:   text("artifact_kind").$type<AuthArtifactKind>().notNull(),
  configJson:     text("config_json", { mode: "json" }).notNull(),
  grantSetJson:   text("grant_set_json", { mode: "json" }),
  ...Timestamps,
}, (table) => [
  index("auth_artifact_source_idx").on(table.workspaceId, table.sourceId),
  index("auth_artifact_slot_idx").on(table.workspaceId, table.sourceId, table.slot),
])

export const auth_lease = sqliteTable("auth_lease", {
  id:                     text().$type<AuthLeaseId>().primaryKey(),
  authArtifactId:         text("auth_artifact_id").$type<AuthArtifactId>().notNull()
                               .references(() => auth_artifact.id, { onDelete: "cascade" }),
  workspaceId:            text("workspace_id").$type<WorkspaceId>().notNull(),
  sourceId:               text("source_id").$type<SourceId>().notNull(),
  actorAccountId:         text("actor_account_id").$type<AccountId | null>(),
  slot:                   text().$type<AuthArtifactSlot>().notNull(),
  placementsTemplateJson: text("placements_template_json", { mode: "json" }).notNull(),
  expiresAt:              integer("expires_at"),
  refreshAfter:           integer("refresh_after"),
  ...Timestamps,
}, (table) => [
  index("auth_lease_artifact_idx").on(table.authArtifactId),
  index("auth_lease_source_idx").on(table.workspaceId, table.sourceId),
])
