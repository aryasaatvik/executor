import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite"
import { SqlClient } from "@effect/sql"
import * as Effect from "effect/Effect"
import * as FileSystem from "@effect/platform/FileSystem"
import { NodeFileSystem } from "@effect/platform-node"

import {
  auth_artifact,
  auth_lease,
  source_oauth_client,
  workspace_oauth_client,
  provider_auth_grant,
  source_auth_session,
  secret_material,
  execution,
  execution_interaction,
  execution_step,
  source,
  policy,
} from "./schema"

// ---------------------------------------------------------------------------
// Types for the JSON state files
// ---------------------------------------------------------------------------

/**
 * Shape of `control-plane-state.json` — matches `LocalControlPlaneState`
 * from `runtime/local/control-plane-store.ts`.
 *
 * All fields use camelCase. Nested JSON is stored as *strings* in the JSON
 * file (e.g. `configJson`, `payloadJson`). The DB `{ mode: "json" }` columns
 * expect parsed objects, so we `JSON.parse` those strings during migration.
 */
interface JsonControlPlaneState {
  version: number
  authArtifacts: Array<{
    id: string
    workspaceId: string
    sourceId: string
    actorAccountId: string | null
    slot: string
    artifactKind: string
    configJson: string
    grantSetJson: string | null
    createdAt: number
    updatedAt: number
  }>
  authLeases: Array<{
    id: string
    authArtifactId: string
    workspaceId: string
    sourceId: string
    actorAccountId: string | null
    slot: string
    placementsTemplateJson: string
    expiresAt: number | null
    refreshAfter: number | null
    createdAt: number
    updatedAt: number
  }>
  sourceOauthClients: Array<{
    id: string
    workspaceId: string
    sourceId: string
    providerKey: string
    clientId: string
    clientSecretProviderId: string | null
    clientSecretHandle: string | null
    clientMetadataJson: string | null
    createdAt: number
    updatedAt: number
  }>
  workspaceOauthClients: Array<{
    id: string
    workspaceId: string
    providerKey: string
    label: string | null
    clientId: string
    clientSecretProviderId: string | null
    clientSecretHandle: string | null
    clientMetadataJson: string | null
    createdAt: number
    updatedAt: number
  }>
  providerAuthGrants: Array<{
    id: string
    workspaceId: string
    actorAccountId: string | null
    providerKey: string
    oauthClientId: string
    tokenEndpoint: string
    clientAuthentication: string
    headerName: string
    prefix: string
    refreshToken: { providerId: string; handle: string }
    grantedScopes: string[]
    lastRefreshedAt: number | null
    orphanedAt: number | null
    createdAt: number
    updatedAt: number
  }>
  sourceAuthSessions: Array<{
    id: string
    workspaceId: string
    sourceId: string
    actorAccountId: string | null
    credentialSlot: string
    executionId: string | null
    interactionId: string | null
    providerKind: string
    status: string
    state: string
    sessionDataJson: string
    errorText: string | null
    completedAt: number | null
    createdAt: number
    updatedAt: number
  }>
  secretMaterials: Array<{
    id: string
    name: string | null
    purpose: string
    providerId: string
    handle: string
    value: string | null
    createdAt: number
    updatedAt: number
  }>
  executions: Array<{
    id: string
    workspaceId: string
    createdByAccountId: string
    status: string
    code: string
    resultJson: string | null
    errorText: string | null
    logsJson: string | null
    startedAt: number | null
    completedAt: number | null
    createdAt: number
    updatedAt: number
  }>
  executionInteractions: Array<{
    id: string
    executionId: string
    status: string
    kind: string
    purpose: string
    payloadJson: string
    responseJson: string | null
    responsePrivateJson: string | null
    createdAt: number
    updatedAt: number
  }>
  executionSteps: Array<{
    id: string
    executionId: string
    sequence: number
    kind: string
    status: string
    path: string
    argsJson: string
    resultJson: string | null
    errorText: string | null
    interactionId: string | null
    createdAt: number
    updatedAt: number
  }>
}

/**
 * Shape of `workspace-state.json` — matches `LocalWorkspaceState`
 * from `runtime/local/workspace-state.ts`.
 */
interface JsonWorkspaceState {
  version: number
  sources: Record<string, {
    status: string
    lastError: string | null
    sourceHash: string | null
    createdAt: number
    updatedAt: number
  }>
  policies: Record<string, {
    id: string
    createdAt: number
    updatedAt: number
  }>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely parse a JSON string, returning null on failure.
 */
const tryParseJson = (value: string | null | undefined): unknown => {
  if (value == null) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/**
 * Read a file as a string using NodeFileSystem. Returns null if the file
 * does not exist or cannot be read.
 */
const readFileOrNull = (path: string): Effect.Effect<string | null, never, never> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(path, "utf8")
  }).pipe(
    Effect.provide(NodeFileSystem.layer),
    Effect.catchAll(() => Effect.succeed(null)),
  )

// ---------------------------------------------------------------------------
// Migration marker check
// ---------------------------------------------------------------------------

/**
 * Check if JSON migration has already been completed.
 * Uses a simple marker row in the `_migration_meta` table.
 */
const isMigrationComplete = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT value FROM _migration_meta WHERE key = 'json_migrated'`.pipe(
    Effect.catchAll(() => Effect.succeed([]))
  )
  return rows.length > 0
})

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Migrate JSON state files into SQLite.
 *
 * Reads `control-plane-state.json` and `workspace-state.json`, inserts all
 * rows into their corresponding SQLite tables inside a single transaction,
 * then marks the migration complete. Idempotent: if the marker row already
 * exists the function returns immediately.
 *
 * File-read errors are tolerated — a fresh install will have no JSON files
 * and the migration simply records itself as done.
 *
 * @param input.controlPlaneStatePath — absolute path to control-plane-state.json
 * @param input.workspaceStatePath — absolute path to workspace-state.json
 */
export const migrateJsonToSqlite = (input: {
  controlPlaneStatePath: string
  workspaceStatePath: string
}) =>
  Effect.gen(function* () {
    const alreadyDone = yield* isMigrationComplete
    if (alreadyDone) return

    const db = yield* SqliteDrizzle
    const sql = yield* SqlClient.SqlClient

    yield* sql.withTransaction(
      Effect.gen(function* () {
        // Ensure marker table exists
        yield* sql`CREATE TABLE IF NOT EXISTS _migration_meta (key TEXT PRIMARY KEY, value TEXT)`

        // -----------------------------------------------------------------
        // Read control-plane-state.json
        // -----------------------------------------------------------------
        const cpStateRaw = yield* readFileOrNull(input.controlPlaneStatePath)

        if (cpStateRaw !== null) {
          const cpState: JsonControlPlaneState = JSON.parse(cpStateRaw)

          // --- auth_artifact ---
          for (const item of cpState.authArtifacts ?? []) {
            yield* db
              .insert(auth_artifact)
              .values({
                id: item.id,
                workspace_id: item.workspaceId,
                source_id: item.sourceId,
                actor_account_id: item.actorAccountId ?? null,
                slot: item.slot,
                artifact_kind: item.artifactKind,
                config_json: tryParseJson(item.configJson),
                grant_set_json: tryParseJson(item.grantSetJson),
                time_created: item.createdAt,
                time_updated: item.updatedAt,
              })
              .onConflictDoNothing()
          }

          // --- auth_lease ---
          for (const item of cpState.authLeases ?? []) {
            yield* db
              .insert(auth_lease)
              .values({
                id: item.id,
                auth_artifact_id: item.authArtifactId,
                workspace_id: item.workspaceId,
                source_id: item.sourceId,
                actor_account_id: item.actorAccountId ?? null,
                slot: item.slot,
                placements_template_json: tryParseJson(item.placementsTemplateJson),
                expires_at: item.expiresAt ?? null,
                refresh_after: item.refreshAfter ?? null,
                time_created: item.createdAt,
                time_updated: item.updatedAt,
              })
              .onConflictDoNothing()
          }

          // --- source_oauth_client ---
          for (const item of cpState.sourceOauthClients ?? []) {
            yield* db
              .insert(source_oauth_client)
              .values({
                id: item.id,
                workspace_id: item.workspaceId,
                source_id: item.sourceId,
                provider_key: item.providerKey,
                client_id: item.clientId,
                client_secret_provider_id: item.clientSecretProviderId ?? null,
                client_secret_handle: item.clientSecretHandle ?? null,
                client_metadata_json: tryParseJson(item.clientMetadataJson),
                time_created: item.createdAt,
                time_updated: item.updatedAt,
              })
              .onConflictDoNothing()
          }

          // --- workspace_oauth_client ---
          // Must be inserted before provider_auth_grant due to FK constraint.
          for (const item of cpState.workspaceOauthClients ?? []) {
            yield* db
              .insert(workspace_oauth_client)
              .values({
                id: item.id,
                workspace_id: item.workspaceId,
                provider_key: item.providerKey,
                label: item.label ?? null,
                client_id: item.clientId,
                client_secret_provider_id: item.clientSecretProviderId ?? null,
                client_secret_handle: item.clientSecretHandle ?? null,
                client_metadata_json: tryParseJson(item.clientMetadataJson),
                time_created: item.createdAt,
                time_updated: item.updatedAt,
              })
              .onConflictDoNothing()
          }

          // --- provider_auth_grant ---
          for (const item of cpState.providerAuthGrants ?? []) {
            yield* db
              .insert(provider_auth_grant)
              .values({
                id: item.id,
                workspace_id: item.workspaceId,
                actor_account_id: item.actorAccountId ?? null,
                provider_key: item.providerKey,
                oauth_client_id: item.oauthClientId,
                token_endpoint: item.tokenEndpoint,
                client_authentication: item.clientAuthentication,
                header_name: item.headerName,
                prefix: item.prefix,
                // refreshToken is an object { providerId, handle } in JSON.
                // The DB column is `{ mode: "json" }`, so pass the object directly.
                refresh_token_ref: item.refreshToken,
                granted_scopes: item.grantedScopes,
                last_refreshed_at: item.lastRefreshedAt ?? null,
                orphaned_at: item.orphanedAt ?? null,
                time_created: item.createdAt,
                time_updated: item.updatedAt,
              })
              .onConflictDoNothing()
          }

          // --- source_auth_session ---
          for (const item of cpState.sourceAuthSessions ?? []) {
            yield* db
              .insert(source_auth_session)
              .values({
                id: item.id,
                workspace_id: item.workspaceId,
                source_id: item.sourceId,
                actor_account_id: item.actorAccountId ?? null,
                credential_slot: item.credentialSlot,
                execution_id: item.executionId ?? null,
                interaction_id: item.interactionId ?? null,
                provider_kind: item.providerKind,
                status: item.status,
                state: item.state,
                session_data_json: tryParseJson(item.sessionDataJson),
                error_text: item.errorText ?? null,
                completed_at: item.completedAt ?? null,
                time_created: item.createdAt,
                time_updated: item.updatedAt,
              })
              .onConflictDoNothing()
          }

          // --- secret_material ---
          for (const item of cpState.secretMaterials ?? []) {
            yield* db
              .insert(secret_material)
              .values({
                id: item.id,
                name: item.name ?? null,
                purpose: item.purpose,
                provider_id: item.providerId,
                handle: item.handle,
                value: item.value ?? null,
                time_created: item.createdAt,
                time_updated: item.updatedAt,
              })
              .onConflictDoNothing()
          }

          // --- execution ---
          // Must be inserted before execution_interaction and execution_step
          // due to FK constraints.
          for (const item of cpState.executions ?? []) {
            yield* db
              .insert(execution)
              .values({
                id: item.id,
                workspace_id: item.workspaceId,
                created_by_account_id: item.createdByAccountId,
                status: item.status,
                code: item.code,
                result_json: tryParseJson(item.resultJson),
                error_text: item.errorText ?? null,
                logs_json: tryParseJson(item.logsJson),
                started_at: item.startedAt ?? null,
                completed_at: item.completedAt ?? null,
                time_created: item.createdAt,
                time_updated: item.updatedAt,
              })
              .onConflictDoNothing()
          }

          // --- execution_interaction ---
          for (const item of cpState.executionInteractions ?? []) {
            yield* db
              .insert(execution_interaction)
              .values({
                id: item.id,
                execution_id: item.executionId,
                status: item.status,
                kind: item.kind,
                purpose: item.purpose,
                payload_json: tryParseJson(item.payloadJson),
                response_json: tryParseJson(item.responseJson),
                response_private_json: tryParseJson(item.responsePrivateJson),
                time_created: item.createdAt,
                time_updated: item.updatedAt,
              })
              .onConflictDoNothing()
          }

          // --- execution_step ---
          for (const item of cpState.executionSteps ?? []) {
            yield* db
              .insert(execution_step)
              .values({
                id: item.id,
                execution_id: item.executionId,
                sequence: item.sequence,
                kind: item.kind,
                status: item.status,
                path: item.path,
                args_json: tryParseJson(item.argsJson),
                result_json: tryParseJson(item.resultJson),
                error_text: item.errorText ?? null,
                interaction_id: item.interactionId ?? null,
                time_created: item.createdAt,
                time_updated: item.updatedAt,
              })
              .onConflictDoNothing()
          }
        }

        // -----------------------------------------------------------------
        // Read workspace-state.json — source status and policies
        // -----------------------------------------------------------------
        const wsStateRaw = yield* readFileOrNull(input.workspaceStatePath)

        if (wsStateRaw !== null) {
          const wsState: JsonWorkspaceState = JSON.parse(wsStateRaw)

          // Source status updates.
          // The `source` table row may already exist (created by the indexer).
          // We update `status`, `last_error`, `source_hash`, and timestamps
          // using a raw upsert to avoid inserting incomplete rows.
          if (wsState.sources) {
            for (const [sourceId, info] of Object.entries(wsState.sources)) {
              yield* sql`
                UPDATE ${source}
                SET status      = ${info.status},
                    last_error  = ${info.lastError},
                    source_hash = ${info.sourceHash},
                    time_updated = ${info.updatedAt}
                WHERE id = ${sourceId}
              `.pipe(Effect.catchAll(() => Effect.void))
            }
          }

          // Policy records from workspace state.
          // The workspace-state only stores { id, createdAt, updatedAt } keyed
          // by a string key. We cannot reconstruct the full policy row (missing
          // resource_pattern, effect, approval_mode, etc.), so we skip policy
          // migration here — the full policy data would need to come from
          // another source. Log a note for debugging.
        }

        // -----------------------------------------------------------------
        // Mark migration complete
        // -----------------------------------------------------------------
        yield* sql`INSERT INTO _migration_meta (key, value) VALUES ('json_migrated', datetime('now'))`
      }),
    )
  })
