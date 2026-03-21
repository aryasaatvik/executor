import { SqlClient } from "@effect/sql"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import { makeDatabaseLive, loadSqliteVecExtension } from "./client"
import { setupCatalogToolFts } from "./fts"
import { migrateJsonToSqlite } from "./migrate-json"
import { setupVecTable, getVecTableDimensions, dropVecTable } from "./vec"

/**
 * Run all table DDL, FTS5 setup, and the one-time JSON→SQLite migration.
 *
 * All CREATE statements are idempotent (IF NOT EXISTS).
 */
const runMigrations = (options?: {
  jsonPaths?: {
    controlPlaneStatePath: string
    workspaceStatePath: string
  }
  embeddingDimensions?: number
}) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // -----------------------------------------------------------------------
  // catalog_tool table
  // -----------------------------------------------------------------------
  yield* sql`
    CREATE TABLE IF NOT EXISTS catalog_tool (
      tool_id           TEXT PRIMARY KEY,
      path              TEXT NOT NULL,
      source_id         TEXT NOT NULL,
      source_key        TEXT NOT NULL,
      namespace         TEXT NOT NULL,
      title             TEXT,
      description       TEXT,
      search_text       TEXT NOT NULL,
      input_schema_json TEXT,
      output_schema_json TEXT,
      input_type_preview TEXT,
      output_type_preview TEXT,
      interaction       TEXT DEFAULT 'auto',
      provider_kind     TEXT,
      content_hash      TEXT NOT NULL,
      source_enabled    INTEGER DEFAULT 1 NOT NULL,
      source_status     TEXT DEFAULT 'connected',
      time_created      INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000),
      time_updated      INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000)
    )
  `

  yield* sql`CREATE INDEX IF NOT EXISTS idx_tool_source ON catalog_tool (source_id)`
  yield* sql`CREATE INDEX IF NOT EXISTS idx_tool_namespace ON catalog_tool (namespace)`
  yield* sql`CREATE INDEX IF NOT EXISTS idx_tool_path ON catalog_tool (path)`

  // -----------------------------------------------------------------------
  // source table
  // -----------------------------------------------------------------------
  yield* sql`
    CREATE TABLE IF NOT EXISTS source (
      id                  TEXT PRIMARY KEY,
      workspace_id        TEXT NOT NULL,
      catalog_id          TEXT,
      catalog_revision_id TEXT,
      name                TEXT NOT NULL,
      kind                TEXT NOT NULL,
      endpoint            TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'draft',
      enabled             INTEGER NOT NULL DEFAULT 1,
      namespace           TEXT,
      icon_url            TEXT,
      import_auth_policy  TEXT,
      binding_config_json TEXT,
      binding_version     INTEGER,
      source_hash         TEXT,
      last_error          TEXT,
      time_created        INTEGER NOT NULL,
      time_updated        INTEGER NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS source_workspace_idx ON source (workspace_id)`
  yield* sql`CREATE INDEX IF NOT EXISTS source_status_idx ON source (workspace_id, status)`

  // -----------------------------------------------------------------------
  // source_catalog + source_catalog_revision
  // -----------------------------------------------------------------------
  yield* sql`
    CREATE TABLE IF NOT EXISTS source_catalog (
      id                  TEXT PRIMARY KEY,
      kind                TEXT NOT NULL,
      adapter_key         TEXT NOT NULL,
      provider_key        TEXT NOT NULL,
      name                TEXT NOT NULL,
      summary             TEXT,
      visibility          TEXT NOT NULL DEFAULT 'private',
      latest_revision_id  TEXT,
      time_created        INTEGER NOT NULL,
      time_updated        INTEGER NOT NULL
    )
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS source_catalog_revision (
      id                    TEXT PRIMARY KEY,
      catalog_id            TEXT NOT NULL REFERENCES source_catalog(id) ON DELETE CASCADE,
      revision_number       INTEGER NOT NULL,
      source_config_json    TEXT,
      import_metadata_json  TEXT,
      import_metadata_hash  TEXT,
      snapshot_hash         TEXT,
      time_created          INTEGER NOT NULL,
      time_updated          INTEGER NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS catalog_revision_catalog_idx ON source_catalog_revision (catalog_id)`

  // -----------------------------------------------------------------------
  // account
  // -----------------------------------------------------------------------
  yield* sql`
    CREATE TABLE IF NOT EXISTS account (
      id            TEXT PRIMARY KEY,
      provider      TEXT NOT NULL,
      subject       TEXT NOT NULL,
      email         TEXT,
      display_name  TEXT,
      time_created  INTEGER NOT NULL,
      time_updated  INTEGER NOT NULL
    )
  `

  // -----------------------------------------------------------------------
  // auth_artifact
  // -----------------------------------------------------------------------
  yield* sql`
    CREATE TABLE IF NOT EXISTS auth_artifact (
      id                TEXT PRIMARY KEY,
      workspace_id      TEXT NOT NULL,
      source_id         TEXT NOT NULL,
      actor_account_id  TEXT,
      slot              TEXT NOT NULL,
      artifact_kind     TEXT NOT NULL,
      config_json       TEXT NOT NULL,
      grant_set_json    TEXT,
      time_created      INTEGER NOT NULL,
      time_updated      INTEGER NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS auth_artifact_source_idx ON auth_artifact (workspace_id, source_id)`
  yield* sql`CREATE INDEX IF NOT EXISTS auth_artifact_slot_idx ON auth_artifact (workspace_id, source_id, slot)`

  // -----------------------------------------------------------------------
  // auth_lease
  // -----------------------------------------------------------------------
  yield* sql`
    CREATE TABLE IF NOT EXISTS auth_lease (
      id                        TEXT PRIMARY KEY,
      auth_artifact_id          TEXT NOT NULL REFERENCES auth_artifact(id) ON DELETE CASCADE,
      workspace_id              TEXT NOT NULL,
      source_id                 TEXT NOT NULL,
      actor_account_id          TEXT,
      slot                      TEXT NOT NULL,
      placements_template_json  TEXT NOT NULL,
      expires_at                INTEGER,
      refresh_after             INTEGER,
      time_created              INTEGER NOT NULL,
      time_updated              INTEGER NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS auth_lease_artifact_idx ON auth_lease (auth_artifact_id)`
  yield* sql`CREATE INDEX IF NOT EXISTS auth_lease_source_idx ON auth_lease (workspace_id, source_id)`

  // -----------------------------------------------------------------------
  // source_oauth_client
  // -----------------------------------------------------------------------
  yield* sql`
    CREATE TABLE IF NOT EXISTS source_oauth_client (
      id                        TEXT PRIMARY KEY,
      workspace_id              TEXT NOT NULL,
      source_id                 TEXT NOT NULL,
      provider_key              TEXT NOT NULL,
      client_id                 TEXT NOT NULL,
      client_secret_provider_id TEXT,
      client_secret_handle      TEXT,
      client_metadata_json      TEXT,
      time_created              INTEGER NOT NULL,
      time_updated              INTEGER NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS source_oauth_client_source_idx ON source_oauth_client (workspace_id, source_id)`

  // -----------------------------------------------------------------------
  // workspace_oauth_client
  // -----------------------------------------------------------------------
  yield* sql`
    CREATE TABLE IF NOT EXISTS workspace_oauth_client (
      id                        TEXT PRIMARY KEY,
      workspace_id              TEXT NOT NULL,
      provider_key              TEXT NOT NULL,
      label                     TEXT,
      client_id                 TEXT NOT NULL,
      client_secret_provider_id TEXT,
      client_secret_handle      TEXT,
      client_metadata_json      TEXT,
      time_created              INTEGER NOT NULL,
      time_updated              INTEGER NOT NULL
    )
  `

  // -----------------------------------------------------------------------
  // provider_auth_grant
  // -----------------------------------------------------------------------
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_auth_grant (
      id                    TEXT PRIMARY KEY,
      workspace_id          TEXT NOT NULL,
      actor_account_id      TEXT,
      provider_key          TEXT NOT NULL,
      oauth_client_id       TEXT NOT NULL REFERENCES workspace_oauth_client(id) ON DELETE CASCADE,
      token_endpoint        TEXT NOT NULL,
      client_authentication TEXT NOT NULL,
      header_name           TEXT NOT NULL,
      prefix                TEXT NOT NULL,
      refresh_token_ref     TEXT NOT NULL,
      granted_scopes        TEXT NOT NULL,
      last_refreshed_at     INTEGER,
      orphaned_at           INTEGER,
      time_created          INTEGER NOT NULL,
      time_updated          INTEGER NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS provider_grant_client_idx ON provider_auth_grant (oauth_client_id)`
  yield* sql`CREATE INDEX IF NOT EXISTS provider_grant_workspace_idx ON provider_auth_grant (workspace_id, provider_key)`

  // -----------------------------------------------------------------------
  // source_auth_session
  // -----------------------------------------------------------------------
  yield* sql`
    CREATE TABLE IF NOT EXISTS source_auth_session (
      id                TEXT PRIMARY KEY,
      workspace_id      TEXT NOT NULL,
      source_id         TEXT NOT NULL,
      actor_account_id  TEXT,
      credential_slot   TEXT NOT NULL,
      execution_id      TEXT,
      interaction_id    TEXT,
      provider_kind     TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      state             TEXT NOT NULL,
      session_data_json TEXT NOT NULL,
      error_text        TEXT,
      completed_at      INTEGER,
      time_created      INTEGER NOT NULL,
      time_updated      INTEGER NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS auth_session_source_idx ON source_auth_session (workspace_id, source_id)`
  yield* sql`CREATE INDEX IF NOT EXISTS auth_session_status_idx ON source_auth_session (status)`

  // -----------------------------------------------------------------------
  // execution
  // -----------------------------------------------------------------------
  yield* sql`
    CREATE TABLE IF NOT EXISTS execution (
      id                    TEXT PRIMARY KEY,
      workspace_id          TEXT NOT NULL,
      created_by_account_id TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'pending',
      code                  TEXT NOT NULL,
      result_json           TEXT,
      error_text            TEXT,
      logs_json             TEXT,
      started_at            INTEGER,
      completed_at          INTEGER,
      time_created          INTEGER NOT NULL,
      time_updated          INTEGER NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS execution_workspace_idx ON execution (workspace_id)`
  yield* sql`CREATE INDEX IF NOT EXISTS execution_status_idx ON execution (workspace_id, status)`

  // -----------------------------------------------------------------------
  // execution_interaction
  // -----------------------------------------------------------------------
  yield* sql`
    CREATE TABLE IF NOT EXISTS execution_interaction (
      id                    TEXT PRIMARY KEY,
      execution_id          TEXT NOT NULL REFERENCES execution(id) ON DELETE CASCADE,
      status                TEXT NOT NULL DEFAULT 'pending',
      kind                  TEXT NOT NULL,
      purpose               TEXT NOT NULL,
      payload_json          TEXT NOT NULL,
      response_json         TEXT,
      response_private_json TEXT,
      time_created          INTEGER NOT NULL,
      time_updated          INTEGER NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS interaction_execution_idx ON execution_interaction (execution_id)`

  // -----------------------------------------------------------------------
  // execution_step
  // -----------------------------------------------------------------------
  yield* sql`
    CREATE TABLE IF NOT EXISTS execution_step (
      id              TEXT PRIMARY KEY,
      execution_id    TEXT NOT NULL REFERENCES execution(id) ON DELETE CASCADE,
      sequence        INTEGER NOT NULL,
      kind            TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      path            TEXT NOT NULL,
      args_json       TEXT NOT NULL,
      result_json     TEXT,
      error_text      TEXT,
      interaction_id  TEXT,
      time_created    INTEGER NOT NULL,
      time_updated    INTEGER NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS step_execution_idx ON execution_step (execution_id)`
  yield* sql`CREATE INDEX IF NOT EXISTS step_execution_seq_idx ON execution_step (execution_id, sequence)`

  // -----------------------------------------------------------------------
  // secret_material
  // -----------------------------------------------------------------------
  yield* sql`
    CREATE TABLE IF NOT EXISTS secret_material (
      id            TEXT PRIMARY KEY,
      name          TEXT,
      purpose       TEXT NOT NULL,
      provider_id   TEXT NOT NULL,
      handle        TEXT NOT NULL,
      value         TEXT,
      time_created  INTEGER NOT NULL,
      time_updated  INTEGER NOT NULL
    )
  `

  // -----------------------------------------------------------------------
  // policy
  // -----------------------------------------------------------------------
  yield* sql`
    CREATE TABLE IF NOT EXISTS policy (
      id               TEXT PRIMARY KEY,
      key              TEXT NOT NULL,
      workspace_id     TEXT NOT NULL,
      resource_pattern TEXT NOT NULL,
      effect           TEXT NOT NULL,
      approval_mode    TEXT NOT NULL,
      priority         INTEGER NOT NULL,
      enabled          INTEGER NOT NULL DEFAULT 1,
      time_created     INTEGER NOT NULL,
      time_updated     INTEGER NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS policy_workspace_idx ON policy (workspace_id)`

  // -----------------------------------------------------------------------
  // FTS5 virtual table + sync triggers
  // -----------------------------------------------------------------------
  yield* setupCatalogToolFts

  // -----------------------------------------------------------------------
  // sqlite-vec: vector table (only when embeddings configured)
  // -----------------------------------------------------------------------
  if (options?.embeddingDimensions) {
    const vecLoaded = yield* loadSqliteVecExtension.pipe(
      Effect.catchAll(() => Effect.succeed(false)),
    )

    if (vecLoaded) {
      // Check if existing vec table has mismatched dimensions
      const existingDims = yield* getVecTableDimensions.pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      )

      if (existingDims !== null && existingDims !== options.embeddingDimensions) {
        yield* Effect.logWarning(
          `Vec table dimension mismatch: existing=${existingDims}, configured=${options.embeddingDimensions}. Recreating vec table.`,
        )
        yield* dropVecTable
      }

      yield* setupVecTable(options.embeddingDimensions)
    }
  }

  // -----------------------------------------------------------------------
  // JSON → SQLite one-time migration
  // -----------------------------------------------------------------------
  if (options?.jsonPaths) {
    yield* migrateJsonToSqlite(options.jsonPaths).pipe(
      Effect.catchAll((error) =>
        Effect.logWarning("JSON→SQLite migration failed (non-fatal)", error)
      ),
    )
  }
})

/**
 * Create the full database layer for the workspace catalog, including
 * schema migrations, FTS5 setup, optional JSON→SQLite data migration,
 * and optional sqlite-vec vector table setup.
 *
 * Usage:
 * ```ts
 * const dbLayer = makeWorkspaceCatalogDbLayer(dbPath)
 * const catalog = yield* createSqliteToolCatalog().pipe(Effect.provide(dbLayer))
 * ```
 *
 * To also run the one-time JSON migration, pass the paths:
 * ```ts
 * const dbLayer = makeWorkspaceCatalogDbLayer(dbPath, {
 *   jsonPaths: {
 *     controlPlaneStatePath: "/path/to/control-plane-state.json",
 *     workspaceStatePath: "/path/to/workspace-state.json",
 *   },
 * })
 * ```
 *
 * To enable vector search (sqlite-vec), pass embedding dimensions:
 * ```ts
 * const dbLayer = makeWorkspaceCatalogDbLayer(dbPath, {
 *   embeddingDimensions: 768,
 * })
 * ```
 */
export const makeWorkspaceCatalogDbLayer = (
  filename: string,
  options?: {
    jsonPaths?: {
      controlPlaneStatePath: string
      workspaceStatePath: string
    }
    embeddingDimensions?: number
  },
) => {
  const dbLive = makeDatabaseLive(filename)

  const migrationLayer = Layer.effectDiscard(runMigrations(options)).pipe(
    Layer.provideMerge(dbLive),
  )

  return migrationLayer
}
