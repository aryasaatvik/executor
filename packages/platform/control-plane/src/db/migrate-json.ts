import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite"
import { SqlClient } from "@effect/sql"
import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as FileSystem from "@effect/platform/FileSystem"
import { NodeFileSystem } from "@effect/platform-node"
import { join } from "node:path"

import { decodeCatalogSnapshotV1, projectCatalogForAgentSdk } from "@executor/ir/catalog"
import type { Capability, CatalogSnapshotV1, CatalogV1, Executable } from "@executor/ir/model"
import { LocalFileSystemError, unknownLocalErrorDetails } from "../runtime/local/errors"
import type {
  AccountId,
  AuthArtifactId,
  AuthArtifactKind,
  AuthArtifactSlot,
  AuthLeaseId,
  CredentialSlot,
  ExecutionId,
  ExecutionInteractionId,
  ExecutionInteractionStatus,
  ExecutionSessionId,
  ExecutionStatus,
  ExecutionStepId,
  ExecutionStepKind,
  ExecutionStepStatus,
  OAuth2ClientAuthenticationMethod,
  ProviderAuthGrantId,
  SecretMaterialId,
  SecretMaterialPurpose,
  SourceAuthSessionId,
  SourceAuthSessionProviderKind,
  SourceAuthSessionStatus,
  SourceId,
  SourceStatus,
  WorkspaceId,
  WorkspaceOauthClientId,
  WorkspaceSourceOauthClientId,
} from "#schema";

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
  catalog,
  catalog_revision,
  catalog_document,
  catalog_tool,
  workspace_state,
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
    id: AuthArtifactId
    workspaceId: WorkspaceId
    sourceId: SourceId
    actorAccountId: AccountId | null
    slot: AuthArtifactSlot
    artifactKind: AuthArtifactKind
    configJson: string
    grantSetJson: string | null
    createdAt: number
    updatedAt: number
  }>
  authLeases: Array<{
    id: AuthLeaseId
    authArtifactId: AuthArtifactId
    workspaceId: WorkspaceId
    sourceId: SourceId
    actorAccountId: AccountId | null
    slot: AuthArtifactSlot
    placementsTemplateJson: string
    expiresAt: number | null
    refreshAfter: number | null
    createdAt: number
    updatedAt: number
  }>
  sourceOauthClients: Array<{
    id: WorkspaceSourceOauthClientId
    workspaceId: WorkspaceId
    sourceId: SourceId
    providerKey: string
    clientId: string
    clientSecretProviderId: string | null
    clientSecretHandle: string | null
    clientMetadataJson: string | null
    createdAt: number
    updatedAt: number
  }>
  workspaceOauthClients: Array<{
    id: WorkspaceOauthClientId
    workspaceId: WorkspaceId
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
    id: ProviderAuthGrantId
    workspaceId: WorkspaceId
    actorAccountId: AccountId | null
    providerKey: string
    oauthClientId: WorkspaceOauthClientId
    tokenEndpoint: string
    clientAuthentication: OAuth2ClientAuthenticationMethod
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
    id: SourceAuthSessionId
    workspaceId: WorkspaceId
    sourceId: SourceId
    actorAccountId: AccountId | null
    credentialSlot: CredentialSlot
    executionId: ExecutionId | null
    interactionId: ExecutionInteractionId | null
    providerKind: SourceAuthSessionProviderKind
    status: SourceAuthSessionStatus
    state: string
    sessionDataJson: string
    errorText: string | null
    completedAt: number | null
    createdAt: number
    updatedAt: number
  }>
  secretMaterials: Array<{
    id: SecretMaterialId
    name: string | null
    purpose: SecretMaterialPurpose
    providerId: string
    handle: string
    value: string | null
    createdAt: number
    updatedAt: number
  }>
  executions: Array<{
    id: ExecutionId
    workspaceId: WorkspaceId
    createdByAccountId: AccountId
    executionSessionId?: ExecutionSessionId | null
    status: ExecutionStatus
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
    id: ExecutionInteractionId
    executionId: ExecutionId
    status: ExecutionInteractionStatus
    kind: string
    purpose: string
    payloadJson: string
    responseJson: string | null
    responsePrivateJson: string | null
    createdAt: number
    updatedAt: number
  }>
  executionSteps: Array<{
    id: ExecutionStepId
    executionId: ExecutionId
    sequence: number
    kind: ExecutionStepKind
    status: ExecutionStepStatus
    path: string
    argsJson: string
    resultJson: string | null
    errorText: string | null
    interactionId: ExecutionInteractionId | null
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
    status: SourceStatus
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
  catalog?: {
    semanticSearchSignature: string | null
  }
}

/**
 * Minimal shape of `LocalSourceArtifact` JSON files found in
 * `artifacts/sources/<sourceId>.json`.
 */
interface JsonSourceArtifact {
  version: number
  sourceId: string
  catalogId: string
  generatedAt: number
  revision: {
    id: string
    catalogId: string
    revisionNumber: number
    sourceConfigJson: string
    importMetadataJson: string | null
    importMetadataHash: string | null
    snapshotHash: string | null
    createdAt: number
    updatedAt: number
  }
  snapshot: unknown
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
 * Read a file as a string using NodeFileSystem, returning null only when the
 * file does not exist.
 */
const readFileIfExists = (
  path: string,
  action: {
    check: string
    read: string
  },
): Effect.Effect<string | null, LocalFileSystemError, never> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(path).pipe(
      Effect.mapError(
        (cause) =>
          new LocalFileSystemError({
            message: `Failed to ${action.check} ${path}: ${unknownLocalErrorDetails(cause)}`,
            action: action.check,
            path,
            details: unknownLocalErrorDetails(cause),
          }),
      ),
    )
    if (!exists) {
      return null
    }

    return yield* fs.readFileString(path, "utf8").pipe(
      Effect.mapError(
        (cause) =>
          new LocalFileSystemError({
            message: `Failed to ${action.read} ${path}: ${unknownLocalErrorDetails(cause)}`,
            action: action.read,
            path,
            details: unknownLocalErrorDetails(cause),
          }),
      ),
    )
  }).pipe(Effect.provide(NodeFileSystem.layer))

/**
 * List JSON files in a directory, returning an empty array when the directory
 * does not exist.
 */
const listJsonFilesIfExists = (
  directory: string,
): Effect.Effect<string[], LocalFileSystemError, never> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(directory).pipe(
      Effect.mapError(
        (cause) =>
          new LocalFileSystemError({
            message: `Failed to check artifacts directory ${directory}: ${unknownLocalErrorDetails(cause)}`,
            action: "check artifacts directory",
            path: directory,
            details: unknownLocalErrorDetails(cause),
          }),
      ),
    )
    if (!exists) {
      return []
    }

    const entries = yield* fs.readDirectory(directory).pipe(
      Effect.mapError(
        (cause) =>
          new LocalFileSystemError({
            message: `Failed to list artifacts directory ${directory}: ${unknownLocalErrorDetails(cause)}`,
            action: "list artifacts directory",
            path: directory,
            details: unknownLocalErrorDetails(cause),
          }),
      ),
    )
    return entries.filter((entry) => entry.endsWith(".json")).map((entry) => join(directory, entry))
  }).pipe(Effect.provide(NodeFileSystem.layer))

/**
 * Try to decode a CatalogSnapshotV1, returning null on failure.
 */
const tryDecodeCatalogSnapshot = (snapshot: unknown): CatalogSnapshotV1 | null => {
  try {
    return decodeCatalogSnapshotV1(snapshot)
  } catch {
    return null
  }
}

/**
 * Build the snapshot_json object for catalog_revision from a CatalogV1.
 * Includes only the collections that aren't stored elsewhere.
 */
const buildSnapshotJson = (cat: CatalogV1): string =>
  JSON.stringify({
    symbols: cat.symbols,
    scopes: cat.scopes,
    responseSets: cat.responseSets,
    resources: cat.resources,
    diagnostics: cat.diagnostics,
  })

/**
 * Choose the preferred executable for a capability, falling back to the first
 * one if no preferred is set.
 */
const chooseExecutableForCapability = (
  cat: CatalogV1,
  capability: Capability,
): Executable | undefined => {
  if (capability.preferredExecutableId) {
    const preferred = cat.executables[capability.preferredExecutableId]
    if (preferred) return preferred
  }
  for (const execId of capability.executableIds) {
    const exec = cat.executables[execId]
    if (exec) return exec
  }
  return undefined
}

/**
 * Remove a file if it exists (best-effort, no error on missing).
 */
const removeFileIfExists = (
  path: string,
): Effect.Effect<void, LocalFileSystemError, never> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(path).pipe(
      Effect.mapError(
        (cause) =>
          new LocalFileSystemError({
            message: `Failed to check file ${path}: ${unknownLocalErrorDetails(cause)}`,
            action: "check file for removal",
            path,
            details: unknownLocalErrorDetails(cause),
          }),
      ),
    )
    if (!exists) return
    yield* fs.remove(path, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new LocalFileSystemError({
            message: `Failed to remove ${path}: ${unknownLocalErrorDetails(cause)}`,
            action: "remove file",
            path,
            details: unknownLocalErrorDetails(cause),
          }),
      ),
    )
  }).pipe(Effect.provide(NodeFileSystem.layer))

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
 * Missing JSON files are treated as absent input for fresh installs.
 * Unexpected read/parse/write failures are surfaced immediately.
 *
 * @param input.controlPlaneStatePath — absolute path to control-plane-state.json
 * @param input.workspaceStatePath — absolute path to workspace-state.json
 */
export const migrateJsonToSqlite = (input: {
  controlPlaneStatePath: string
  workspaceStatePath: string
  artifactsDirectory?: string
  workspaceId?: string
}) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle
    const sql = yield* SqlClient.SqlClient

    yield* sql`CREATE TABLE IF NOT EXISTS _migration_meta (key TEXT PRIMARY KEY, value TEXT)`

    const alreadyDone = yield* sql`SELECT value FROM _migration_meta WHERE key = 'json_migrated'`
    if (alreadyDone.length > 0) return

    yield* sql.withTransaction(
      Effect.gen(function* () {
        // -----------------------------------------------------------------
        // Read control-plane-state.json
        // -----------------------------------------------------------------
        const cpStateRaw = yield* readFileIfExists(
          input.controlPlaneStatePath,
          {
            check: "check control plane state path",
            read: "read control plane state",
          },
        )

        if (cpStateRaw !== null) {
          const cpState: JsonControlPlaneState = JSON.parse(cpStateRaw)

          // --- auth_artifact ---
          for (const item of cpState.authArtifacts ?? []) {
            const row = {
              id: item.id,
              workspaceId: item.workspaceId,
              sourceId: item.sourceId,
              actorAccountId: item.actorAccountId ?? null,
              slot: item.slot,
              artifactKind: item.artifactKind,
              configJson: tryParseJson(item.configJson),
              grantSetJson: tryParseJson(item.grantSetJson),
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
            } satisfies typeof auth_artifact.$inferInsert

            yield* db
              .insert(auth_artifact)
              .values(row)
              .onConflictDoNothing()
          }

          // --- auth_lease ---
          for (const item of cpState.authLeases ?? []) {
            yield* db
              .insert(auth_lease)
              .values({
                id: item.id,
                authArtifactId: item.authArtifactId,
                workspaceId: item.workspaceId,
                sourceId: item.sourceId,
                actorAccountId: item.actorAccountId ?? null,
                slot: item.slot,
                placementsTemplateJson: tryParseJson(item.placementsTemplateJson),
                expiresAt: item.expiresAt ?? null,
                refreshAfter: item.refreshAfter ?? null,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
              })
              .onConflictDoNothing()
          }

          // --- source_oauth_client ---
          for (const item of cpState.sourceOauthClients ?? []) {
            yield* db
              .insert(source_oauth_client)
              .values({
                id: item.id,
                workspaceId: item.workspaceId,
                sourceId: item.sourceId,
                providerKey: item.providerKey,
                clientId: item.clientId,
                clientSecretProviderId: item.clientSecretProviderId ?? null,
                clientSecretHandle: item.clientSecretHandle ?? null,
                clientMetadataJson: tryParseJson(item.clientMetadataJson),
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
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
                workspaceId: item.workspaceId,
                providerKey: item.providerKey,
                label: item.label ?? null,
                clientId: item.clientId,
                clientSecretProviderId: item.clientSecretProviderId ?? null,
                clientSecretHandle: item.clientSecretHandle ?? null,
                clientMetadataJson: tryParseJson(item.clientMetadataJson),
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
              })
              .onConflictDoNothing()
          }

          // --- provider_auth_grant ---
          for (const item of cpState.providerAuthGrants ?? []) {
            const row = {
              id: item.id,
              workspaceId: item.workspaceId,
              actorAccountId: item.actorAccountId ?? null,
              providerKey: item.providerKey,
              oauthClientId: item.oauthClientId,
              tokenEndpoint: item.tokenEndpoint,
              clientAuthentication: item.clientAuthentication,
              headerName: item.headerName,
              prefix: item.prefix,
              refreshTokenRef: item.refreshToken,
              grantedScopes: item.grantedScopes,
              lastRefreshedAt: item.lastRefreshedAt ?? null,
              orphanedAt: item.orphanedAt ?? null,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
            } satisfies typeof provider_auth_grant.$inferInsert

            yield* db
              .insert(provider_auth_grant)
              .values(row)
              .onConflictDoNothing()
          }

          // --- source_auth_session ---
          for (const item of cpState.sourceAuthSessions ?? []) {
            yield* db
              .insert(source_auth_session)
              .values({
                id: item.id,
                workspaceId: item.workspaceId,
                sourceId: item.sourceId,
                actorAccountId: item.actorAccountId ?? null,
                credentialSlot: item.credentialSlot,
                executionId: item.executionId ?? null,
                interactionId: item.interactionId ?? null,
                providerKind: item.providerKind,
                status: item.status,
                state: item.state,
                sessionDataJson: tryParseJson(item.sessionDataJson),
                errorText: item.errorText ?? null,
                completedAt: item.completedAt ?? null,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
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
                providerId: item.providerId,
                handle: item.handle,
                value: item.value ?? null,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
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
                workspaceId: item.workspaceId,
                createdByAccountId: item.createdByAccountId,
                executionSessionId: item.executionSessionId ?? null,
                status: item.status,
                code: item.code,
                resultJson: tryParseJson(item.resultJson),
                errorText: item.errorText ?? null,
                logsJson: tryParseJson(item.logsJson),
                startedAt: item.startedAt ?? null,
                completedAt: item.completedAt ?? null,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
              })
              .onConflictDoNothing()
          }

          // --- execution_interaction ---
          for (const item of cpState.executionInteractions ?? []) {
            yield* db
              .insert(execution_interaction)
              .values({
                id: item.id,
                executionId: item.executionId,
                status: item.status,
                kind: item.kind,
                purpose: item.purpose,
                payloadJson: tryParseJson(item.payloadJson),
                responseJson: tryParseJson(item.responseJson),
                responsePrivateJson: tryParseJson(item.responsePrivateJson),
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
              })
              .onConflictDoNothing()
          }

          // --- execution_step ---
          for (const item of cpState.executionSteps ?? []) {
            yield* db
              .insert(execution_step)
              .values({
                id: item.id,
                executionId: item.executionId,
                sequence: item.sequence,
                kind: item.kind,
                status: item.status,
                path: item.path,
                argsJson: tryParseJson(item.argsJson),
                resultJson: tryParseJson(item.resultJson),
                errorText: item.errorText ?? null,
                interactionId: item.interactionId ?? null,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
              })
              .onConflictDoNothing()
          }
        }

        // -----------------------------------------------------------------
        // Read workspace-state.json — source status and policies
        // -----------------------------------------------------------------
        const wsStateRaw = yield* readFileIfExists(
          input.workspaceStatePath,
          {
            check: "check workspace state path",
            read: "read workspace state",
          },
        )

        if (wsStateRaw !== null) {
          const wsState: JsonWorkspaceState = JSON.parse(wsStateRaw)

          if (Object.keys(wsState.policies ?? {}).length > 0) {
            return yield* Effect.fail(
              new Error(
                "workspace-state.json policies cannot be migrated into SQLite without losing data",
              ),
            )
          }

          // Source status updates.
          // The `source` table row may already exist (created by the indexer).
          // We update `status`, `last_error`, `source_hash`, and timestamps
          // using a raw upsert to avoid inserting incomplete rows.
          if (wsState.sources) {
            for (const [sourceId, info] of Object.entries(wsState.sources)) {
              const existingSourceRows = yield* db
                .select({ id: source.id })
                .from(source)
                .where(eq(source.id, sourceId as SourceId))
                .limit(1)

              if (existingSourceRows.length === 0) {
                return yield* Effect.fail(
                  new Error(
                    `workspace-state.json contains source state for ${sourceId}, but no source row exists to receive it; migration cannot preserve this state losslessly`,
                  ),
                )
              }

              yield* sql`
                UPDATE ${source}
                SET status      = ${info.status},
                    last_error  = ${info.lastError},
                    source_hash = ${info.sourceHash},
                    updated_at = ${info.updatedAt}
                WHERE id = ${sourceId}
              `
            }
          }

          // Persist semantic search signature into workspace_state table.
          if (wsState.catalog?.semanticSearchSignature != null && input.workspaceId) {
            yield* db
              .insert(workspace_state)
              .values({
                workspaceId: input.workspaceId as WorkspaceId,
                key: "catalog.semanticSearchSignature",
                value: wsState.catalog.semanticSearchSignature,
                updatedAt: Date.now(),
              })
              .onConflictDoNothing()
          }
        }

        // -----------------------------------------------------------------
        // Import artifact files → catalog_revision + catalog_document
        // -----------------------------------------------------------------
        if (input.artifactsDirectory) {
          const sourcesDir = join(input.artifactsDirectory, "sources")
          const artifactFiles = yield* listJsonFilesIfExists(sourcesDir)

          for (const artifactPath of artifactFiles) {
            yield* Effect.gen(function* () {
              const raw = yield* readFileIfExists(artifactPath, {
                check: "check artifact file",
                read: "read artifact file",
              })
              if (raw === null) return

              const artifact: JsonSourceArtifact = JSON.parse(raw)
              const rev = artifact.revision
              if (!rev?.id || !rev?.catalogId) return

              // Decode snapshot — best effort
              const snapshot = tryDecodeCatalogSnapshot(artifact.snapshot)

              const now = Date.now()

              // --- catalog (parent row) ---
              yield* db
                .insert(catalog)
                .values({
                  id: rev.catalogId as typeof catalog.$inferInsert.id,
                  kind: "source" as typeof catalog.$inferInsert.kind,
                  adapterKey: "",
                  providerKey: "",
                  name: artifact.sourceId,
                  visibility: "private" as typeof catalog.$inferInsert.visibility,
                  latestRevisionId: rev.id as typeof catalog_revision.$inferInsert.id,
                  createdAt: rev.createdAt ?? now,
                  updatedAt: rev.updatedAt ?? now,
                })
                .onConflictDoNothing()

              // --- catalog_revision (with structured snapshot_json) ---
              yield* db
                .insert(catalog_revision)
                .values({
                  id: rev.id as typeof catalog_revision.$inferInsert.id,
                  catalogId: rev.catalogId as typeof catalog_revision.$inferInsert.catalogId,
                  revisionNumber: rev.revisionNumber,
                  sourceConfigJson: tryParseJson(rev.sourceConfigJson),
                  importMetadataJson: tryParseJson(rev.importMetadataJson),
                  importMetadataHash: rev.importMetadataHash ?? null,
                  snapshotHash: rev.snapshotHash ?? null,
                  snapshotJson: snapshot ? buildSnapshotJson(snapshot.catalog) : null,
                  createdAt: rev.createdAt ?? now,
                  updatedAt: rev.updatedAt ?? now,
                })
                .onConflictDoNothing()

              if (snapshot) {
                // --- catalog_document (source document native blobs) ---
                for (const [documentId, document] of Object.entries(snapshot.catalog.documents)) {
                  const sourceDocBlob = document.native?.find(
                    (blob) => blob.kind === "source_document" && typeof blob.value === "string",
                  )
                  if (!sourceDocBlob || typeof sourceDocBlob.value !== "string") {
                    // Also check for sidecar document files
                    const sidecarDir = join(sourcesDir, artifact.sourceId, "documents")
                    const sidecarPath = join(sidecarDir, `${documentId}.txt`)
                    const sidecarContent = yield* readFileIfExists(sidecarPath, {
                      check: "check sidecar document",
                      read: "read sidecar document",
                    })
                    if (sidecarContent !== null) {
                      yield* db
                        .insert(catalog_document)
                        .values({
                          id: `${rev.id}:${documentId}`,
                          revisionId: rev.id as typeof catalog_document.$inferInsert.revisionId,
                          documentId,
                          content: sidecarContent,
                          createdAt: now,
                        })
                        .onConflictDoNothing()
                    }
                    continue
                  }

                  yield* db
                    .insert(catalog_document)
                    .values({
                      id: `${rev.id}:${documentId}`,
                      revisionId: rev.id as typeof catalog_document.$inferInsert.revisionId,
                      documentId,
                      content: sourceDocBlob.value,
                      createdAt: now,
                    })
                    .onConflictDoNothing()
                }

                // --- catalog_tool capability_json + executable_json ---
                // Project catalog to derive tool paths, then update matching rows.
                try {
                  const projected = projectCatalogForAgentSdk({ catalog: snapshot.catalog })
                  for (const capability of Object.values(snapshot.catalog.capabilities)) {
                    const toolDescriptor = projected.toolDescriptors[capability.id]
                    if (!toolDescriptor) continue
                    const toolPath = toolDescriptor.toolPath.join(".")
                    if (!toolPath) continue

                    const executable = chooseExecutableForCapability(snapshot.catalog, capability)
                    const capabilityJson = JSON.stringify(capability)
                    const executableJson = executable ? JSON.stringify(executable) : null

                    yield* sql`
                      UPDATE ${catalog_tool}
                      SET capability_json = ${capabilityJson},
                          executable_json = ${executableJson}
                      WHERE tool_id = ${toolPath}
                        AND source_id = ${artifact.sourceId}
                    `
                  }
                } catch {
                  // Projection failure is non-fatal for migration
                  yield* Effect.logWarning(
                    `Could not project catalog for artifact ${artifact.sourceId}, skipping capability_json/executable_json`,
                  )
                }
              }
            }).pipe(
              // Best-effort: log warning and continue on failure
              Effect.catchAll((error) =>
                Effect.logWarning(
                  `Skipping artifact file ${artifactPath}: ${error instanceof Error ? error.message : String(error)}`,
                ),
              ),
            )
          }
        }

        // -----------------------------------------------------------------
        // Mark migration complete
        // -----------------------------------------------------------------
        yield* sql`INSERT INTO _migration_meta (key, value) VALUES ('json_migrated', datetime('now'))`
      }),
    )

    // -------------------------------------------------------------------
    // Clean up old files after successful migration
    // -------------------------------------------------------------------
    yield* Effect.gen(function* () {
      yield* removeFileIfExists(input.controlPlaneStatePath)
      yield* removeFileIfExists(input.workspaceStatePath)
      if (input.artifactsDirectory) {
        yield* removeFileIfExists(join(input.artifactsDirectory, "sources"))
      }
    }).pipe(
      Effect.catchAll((error) =>
        Effect.logWarning(
          `Could not clean up old files after migration: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ),
    )
  })
