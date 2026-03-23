import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

import type {
  SourceCatalogId,
  SourceCatalogRevisionId,
  SourceKind,
  SourceId,
  SourceStatus,
  WorkspaceId,
} from "#schema"

import { Timestamps } from "../schema.sql"

export const source = sqliteTable("source", {
  id:                text().$type<SourceId>().primaryKey(),
  workspaceId:       text("workspace_id").$type<WorkspaceId>().notNull(),
  catalogId:         text("catalog_id").$type<SourceCatalogId | null>(),
  catalogRevisionId: text("catalog_revision_id").$type<SourceCatalogRevisionId | null>(),
  name:              text().notNull(),
  kind:              text().$type<SourceKind>().notNull(),
  endpoint:          text().notNull(),
  status:            text().$type<SourceStatus>().notNull().default("draft"),
  enabled:           integer({ mode: "boolean" }).notNull().default(true),
  namespace:         text(),
  iconUrl:           text("icon_url"),
  importAuthPolicy:  text("import_auth_policy", { mode: "json" }),
  bindingConfigJson: text("binding_config_json", { mode: "json" }),
  bindingVersion:    integer("binding_version"),
  sourceHash:        text("source_hash"),
  lastError:         text("last_error"),
  ...Timestamps,
}, (table) => [
  index("source_workspace_idx").on(table.workspaceId),
  index("source_status_idx").on(table.workspaceId, table.status),
])
