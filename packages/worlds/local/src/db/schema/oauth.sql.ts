import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

import type {
  AccountId,
  ProviderAuthGrant,
  ProviderAuthGrantId,
  SourceId,
  WorkspaceId,
  WorkspaceOauthClientId,
} from "@executor/control-plane/model"

import type { WorkspaceSourceOauthClientId } from "../types"

import { Timestamps } from "../schema.sql"

export const source_oauth_client = sqliteTable("source_oauth_client", {
  id:                     text().$type<WorkspaceSourceOauthClientId>().primaryKey(),
  workspaceId:            text("workspace_id").$type<WorkspaceId>().notNull(),
  sourceId:               text("source_id").$type<SourceId>().notNull(), // FK: source.id (added in migration)
  providerKey:            text("provider_key").notNull(),
  clientId:               text("client_id").notNull(),
  clientSecretProviderId: text("client_secret_provider_id"),
  clientSecretHandle:     text("client_secret_handle"),
  clientMetadataJson:     text("client_metadata_json", { mode: "json" }),
  ...Timestamps,
}, (table) => [
  index("source_oauth_client_source_idx").on(table.workspaceId, table.sourceId),
])

export const workspace_oauth_client = sqliteTable("workspace_oauth_client", {
  id:                     text().$type<WorkspaceOauthClientId>().primaryKey(),
  workspaceId:            text("workspace_id").$type<WorkspaceId>().notNull(),
  providerKey:            text("provider_key").notNull(),
  label:                  text(),
  clientId:               text("client_id").notNull(),
  clientSecretProviderId: text("client_secret_provider_id"),
  clientSecretHandle:     text("client_secret_handle"),
  clientMetadataJson:     text("client_metadata_json", { mode: "json" }),
  ...Timestamps,
})

export const provider_auth_grant = sqliteTable("provider_auth_grant", {
  id:                   text().$type<ProviderAuthGrantId>().primaryKey(),
  workspaceId:          text("workspace_id").$type<WorkspaceId>().notNull(),
  actorAccountId:       text("actor_account_id").$type<AccountId | null>(),
  providerKey:          text("provider_key").notNull(),
  oauthClientId:        text("oauth_client_id").$type<WorkspaceOauthClientId>().notNull()
                           .references(() => workspace_oauth_client.id, { onDelete: "cascade" }),
  tokenEndpoint:        text("token_endpoint").notNull(),
  clientAuthentication: text("client_authentication").$type<ProviderAuthGrant["clientAuthentication"]>().notNull(),
  headerName:           text("header_name").notNull(),
  prefix:               text().notNull(),
  refreshTokenRef:      text("refresh_token_ref", { mode: "json" }).$type<ProviderAuthGrant["refreshToken"]>().notNull(),
  grantedScopes:        text("granted_scopes", { mode: "json" }).$type<ProviderAuthGrant["grantedScopes"]>().notNull(),
  lastRefreshedAt:      integer("last_refreshed_at"),
  orphanedAt:           integer("orphaned_at"),
  ...Timestamps,
}, (table) => [
  index("provider_grant_client_idx").on(table.oauthClientId),
  index("provider_grant_workspace_idx").on(table.workspaceId, table.providerKey),
])
