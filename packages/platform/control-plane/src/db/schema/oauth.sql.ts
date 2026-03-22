import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../schema.sql"

export const source_oauth_client = sqliteTable("source_oauth_client", {
  id:                        text().primaryKey(),
  workspace_id:              text().notNull(),
  source_id:                 text().notNull(), // FK: source.id (added in migration)
  provider_key:              text().notNull(),
  client_id:                 text().notNull(),
  client_secret_provider_id: text(),
  client_secret_handle:      text(),
  client_metadata_json:      text({ mode: "json" }),
  ...Timestamps,
}, (table) => [
  index("source_oauth_client_source_idx").on(table.workspace_id, table.source_id),
])

export const workspace_oauth_client = sqliteTable("workspace_oauth_client", {
  id:                        text().primaryKey(),
  workspace_id:              text().notNull(),
  provider_key:              text().notNull(),
  label:                     text(),
  client_id:                 text().notNull(),
  client_secret_provider_id: text(),
  client_secret_handle:      text(),
  client_metadata_json:      text({ mode: "json" }),
  ...Timestamps,
})

export const provider_auth_grant = sqliteTable("provider_auth_grant", {
  id:                    text().primaryKey(),
  workspace_id:          text().notNull(),
  actor_account_id:      text(),
  provider_key:          text().notNull(),
  oauth_client_id:       text().notNull()
                           .references(() => workspace_oauth_client.id, { onDelete: "cascade" }),
  token_endpoint:        text().notNull(),
  client_authentication: text().notNull(),
  header_name:           text().notNull(),
  prefix:                text().notNull(),
  refresh_token_ref:     text({ mode: "json" }).notNull(),
  granted_scopes:        text({ mode: "json" }).notNull(),
  last_refreshed_at:     integer(),
  orphaned_at:           integer(),
  ...Timestamps,
}, (table) => [
  index("provider_grant_client_idx").on(table.oauth_client_id),
  index("provider_grant_workspace_idx").on(table.workspace_id, table.provider_key),
])
