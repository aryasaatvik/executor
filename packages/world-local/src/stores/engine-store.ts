import { EXECUTOR_DB_FILENAME } from "../db/client"
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { SqlClient } from "@effect/sql";
import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";
import {
  and,
  asc,
  desc,
  eq,
  isNull,
} from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";

import {
  auth_artifact,
  auth_lease,
  execution,
  execution_interaction,
  execution_step,
  provider_auth_grant,
  secret_material,
  source_auth_session,
  source_oauth_client,
  workspace_oauth_client,
} from "../db/schema";
import { makeWorkspaceCatalogDbLayer } from "../db/setup";
import type { ResolvedLocalWorkspaceContext } from "../config/config";
import { unknownLocalErrorDetails } from "../errors";

import type {
  AuthArtifact,
  AuthLease,
  ExecutionRecord as Execution,
  ExecutionInteraction,
  ExecutionStep,
  ProviderAuthGrant,
  SecretMaterial,
  SourceAuthSession,
  WorkspaceOauthClient,
  WorkspaceSourceOauthClient,
} from "@executor/core/model";

export type LocalEnginePersistence = {
  rows: LocalEngineStore;
  close: () => Promise<void>;
};

type SecretMaterialSummary = {
  id: string;
  providerId: string;
  name: string | null;
  purpose: string;
  createdAt: number;
  updatedAt: number;
};

const workspaceDbPath = (context: ResolvedLocalWorkspaceContext): string =>
  join(context.stateDirectory, EXECUTOR_DB_FILENAME);

const ensureWorkspaceStateDirectory = (
  context: ResolvedLocalWorkspaceContext,
): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(context.stateDirectory, { recursive: true }).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );
  }).pipe(Effect.provide(NodeFileSystem.layer));

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const nullableEquals = <T>(column: T, value: string | null | undefined) =>
  value == null ? isNull(column as never) : eq(column as never, value);

const jsonString = (value: unknown): string => JSON.stringify(value);

const jsonStringOrNull = (value: unknown | null): string | null =>
  value === null ? null : JSON.stringify(value);

const parseJson = (value: string, field: string) =>
  Effect.try({
    try: () => JSON.parse(value),
    catch: (cause) =>
      new Error(`Failed to parse ${field}: ${unknownLocalErrorDetails(cause)}`),
  });

const parseNullableJson = (value: string | null, field: string) =>
  value === null ? Effect.succeed<unknown | null>(null) : parseJson(value, field);

const optionFromNullable = <T>(value: T | null | undefined) =>
  value == null ? Option.none<T>() : Option.some(value);

const toAuthArtifact = (
  row: typeof auth_artifact.$inferSelect,
): AuthArtifact => ({
  ...row,
  configJson: jsonString(row.configJson),
  grantSetJson: jsonStringOrNull(row.grantSetJson),
}) as AuthArtifact;

const toAuthLease = (
  row: typeof auth_lease.$inferSelect,
): AuthLease => ({
  ...row,
  placementsTemplateJson: jsonString(row.placementsTemplateJson),
}) as AuthLease;

const toSourceOauthClient = (
  row: typeof source_oauth_client.$inferSelect,
): WorkspaceSourceOauthClient => ({
  ...row,
  clientMetadataJson: jsonStringOrNull(row.clientMetadataJson),
}) as WorkspaceSourceOauthClient;

const toWorkspaceOauthClient = (
  row: typeof workspace_oauth_client.$inferSelect,
): WorkspaceOauthClient => ({
  ...row,
  clientMetadataJson: jsonStringOrNull(row.clientMetadataJson),
}) as WorkspaceOauthClient;

const toProviderAuthGrant = (
  row: typeof provider_auth_grant.$inferSelect,
): ProviderAuthGrant => ({
  ...row,
  clientAuthentication: row.clientAuthentication as ProviderAuthGrant["clientAuthentication"],
  refreshToken: row.refreshTokenRef as ProviderAuthGrant["refreshToken"],
  grantedScopes: row.grantedScopes as ProviderAuthGrant["grantedScopes"],
}) as unknown as ProviderAuthGrant;

const toSourceAuthSession = (
  row: typeof source_auth_session.$inferSelect,
): SourceAuthSession => ({
  ...row,
  status: row.status as SourceAuthSession["status"],
  sessionDataJson: jsonString(row.sessionDataJson),
}) as SourceAuthSession;

const toSecretMaterial = (
  row: typeof secret_material.$inferSelect,
): SecretMaterial => ({
  ...row,
}) as SecretMaterial;

const toExecution = (
  row: typeof execution.$inferSelect,
): Execution => ({
  ...row,
  executionSessionId: row.executionSessionId ?? null,
  status: row.status as Execution["status"],
  resultJson: jsonStringOrNull(row.resultJson),
  logsJson: jsonStringOrNull(row.logsJson),
}) as Execution;

const toExecutionInteraction = (
  row: typeof execution_interaction.$inferSelect,
): ExecutionInteraction => ({
  ...row,
  status: row.status as ExecutionInteraction["status"],
  payloadJson: jsonString(row.payloadJson),
  responseJson: jsonStringOrNull(row.responseJson),
  responsePrivateJson: jsonStringOrNull(row.responsePrivateJson),
}) as ExecutionInteraction;

const toExecutionStep = (
  row: typeof execution_step.$inferSelect,
): ExecutionStep => ({
  ...row,
  kind: row.kind as ExecutionStep["kind"],
  status: row.status as ExecutionStep["status"],
  argsJson: jsonString(row.argsJson),
  resultJson: jsonStringOrNull(row.resultJson),
}) as ExecutionStep;

const createSqliteEngineStore = (
  runtime: ManagedRuntime.ManagedRuntime<any, any>,
) => {
  const run = <A, E>(
    effect: Effect.Effect<A, E, SqliteDrizzle | SqlClient.SqlClient>,
  ): Effect.Effect<A, Error | E, never> =>
    effect.pipe(
      Effect.provide(runtime),
      Effect.mapError((cause) => cause as Error | E),
    );

  return {
    authArtifacts: {
      listByWorkspaceId: (workspaceId: AuthArtifact["workspaceId"]) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(auth_artifact)
              .where(eq(auth_artifact.workspaceId, workspaceId))
              .orderBy(asc(auth_artifact.updatedAt), asc(auth_artifact.id));

            return rows.map(toAuthArtifact);
          }),
        ),

      listByWorkspaceAndSourceId: (input: {
        workspaceId: AuthArtifact["workspaceId"];
        sourceId: AuthArtifact["sourceId"];
      }) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(auth_artifact)
              .where(
                and(
                  eq(auth_artifact.workspaceId, input.workspaceId),
                  eq(auth_artifact.sourceId, input.sourceId),
                ),
              )
              .orderBy(asc(auth_artifact.updatedAt), asc(auth_artifact.id));

            return rows.map(toAuthArtifact);
          }),
        ),

      getByWorkspaceSourceAndActor: (input: {
        workspaceId: AuthArtifact["workspaceId"];
        sourceId: AuthArtifact["sourceId"];
        actorAccountId: AuthArtifact["actorAccountId"];
        slot: AuthArtifact["slot"];
      }) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(auth_artifact)
              .where(
                and(
                  eq(auth_artifact.workspaceId, input.workspaceId),
                  eq(auth_artifact.sourceId, input.sourceId),
                  eq(auth_artifact.slot, input.slot),
                  nullableEquals(auth_artifact.actorAccountId, input.actorAccountId),
                ),
              )
              .limit(1);

            return optionFromNullable(rows[0] ? toAuthArtifact(rows[0]) : null);
          }),
        ),

      upsert: (artifact: AuthArtifact) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const sql = yield* SqlClient.SqlClient;
            const configJson = yield* parseJson(
              artifact.configJson,
              "auth artifact configJson",
            );
            const grantSetJson = yield* parseNullableJson(
              artifact.grantSetJson,
              "auth artifact grantSetJson",
            );

            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* db
                  .delete(auth_artifact)
                  .where(
                    and(
                      eq(auth_artifact.workspaceId, artifact.workspaceId),
                      eq(auth_artifact.sourceId, artifact.sourceId),
                      eq(auth_artifact.slot, artifact.slot),
                      nullableEquals(auth_artifact.actorAccountId, artifact.actorAccountId),
                    ),
                  );

                yield* db.insert(auth_artifact).values({
                  ...artifact,
                  configJson,
                  grantSetJson,
                });
              }),
            );
          }),
        ),

      removeByWorkspaceSourceAndActor: (input: {
        workspaceId: AuthArtifact["workspaceId"];
        sourceId: AuthArtifact["sourceId"];
        actorAccountId: AuthArtifact["actorAccountId"];
        slot?: AuthArtifact["slot"];
      }) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const deleted = yield* db
              .delete(auth_artifact)
              .where(
                and(
                  eq(auth_artifact.workspaceId, input.workspaceId),
                  eq(auth_artifact.sourceId, input.sourceId),
                  nullableEquals(auth_artifact.actorAccountId, input.actorAccountId),
                  input.slot === undefined
                    ? undefined
                    : eq(auth_artifact.slot, input.slot),
                ),
              )
              .returning({ id: auth_artifact.id });

            return deleted.length > 0;
          }),
        ),

      removeByWorkspaceAndSourceId: (input: {
        workspaceId: AuthArtifact["workspaceId"];
        sourceId: AuthArtifact["sourceId"];
      }) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const deleted = yield* db
              .delete(auth_artifact)
              .where(
                and(
                  eq(auth_artifact.workspaceId, input.workspaceId),
                  eq(auth_artifact.sourceId, input.sourceId),
                ),
              )
              .returning({ id: auth_artifact.id });

            return deleted.length;
          }),
        ),
    },

    authLeases: {
      listAll: () =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(auth_lease)
              .orderBy(asc(auth_lease.updatedAt), asc(auth_lease.id));

            return rows.map(toAuthLease);
          }),
        ),

      getByAuthArtifactId: (authArtifactId: AuthLease["authArtifactId"]) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(auth_lease)
              .where(eq(auth_lease.authArtifactId, authArtifactId))
              .limit(1);

            return optionFromNullable(rows[0] ? toAuthLease(rows[0]) : null);
          }),
        ),

      upsert: (lease: AuthLease) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const sql = yield* SqlClient.SqlClient;
            const placementsTemplateJson = yield* parseJson(
              lease.placementsTemplateJson,
              "auth lease placementsTemplateJson",
            );

            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* db
                  .delete(auth_lease)
                  .where(eq(auth_lease.authArtifactId, lease.authArtifactId));

                yield* db.insert(auth_lease).values({
                  ...lease,
                  placementsTemplateJson,
                });
              }),
            );
          }),
        ),

      removeByAuthArtifactId: (authArtifactId: AuthLease["authArtifactId"]) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const deleted = yield* db
              .delete(auth_lease)
              .where(eq(auth_lease.authArtifactId, authArtifactId))
              .returning({ id: auth_lease.id });

            return deleted.length > 0;
          }),
        ),
    },

    sourceOauthClients: {
      getByWorkspaceSourceAndProvider: (input: {
        workspaceId: WorkspaceSourceOauthClient["workspaceId"];
        sourceId: WorkspaceSourceOauthClient["sourceId"];
        providerKey: string;
      }) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(source_oauth_client)
              .where(
                and(
                  eq(source_oauth_client.workspaceId, input.workspaceId),
                  eq(source_oauth_client.sourceId, input.sourceId),
                  eq(source_oauth_client.providerKey, input.providerKey),
                ),
              )
              .limit(1);

            return optionFromNullable(rows[0] ? toSourceOauthClient(rows[0]) : null);
          }),
        ),

      upsert: (oauthClient: WorkspaceSourceOauthClient) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const sql = yield* SqlClient.SqlClient;
            const clientMetadataJson = yield* parseNullableJson(
              oauthClient.clientMetadataJson,
              "source oauth client clientMetadataJson",
            );

            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* db
                  .delete(source_oauth_client)
                  .where(
                    and(
                      eq(source_oauth_client.workspaceId, oauthClient.workspaceId),
                      eq(source_oauth_client.sourceId, oauthClient.sourceId),
                      eq(source_oauth_client.providerKey, oauthClient.providerKey),
                    ),
                  );

                yield* db.insert(source_oauth_client).values({
                  ...oauthClient,
                  clientMetadataJson,
                });
              }),
            );
          }),
        ),

      removeByWorkspaceAndSourceId: (input: {
        workspaceId: WorkspaceSourceOauthClient["workspaceId"];
        sourceId: WorkspaceSourceOauthClient["sourceId"];
      }) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const deleted = yield* db
              .delete(source_oauth_client)
              .where(
                and(
                  eq(source_oauth_client.workspaceId, input.workspaceId),
                  eq(source_oauth_client.sourceId, input.sourceId),
                ),
              )
              .returning({ id: source_oauth_client.id });

            return deleted.length;
          }),
        ),
    },

    workspaceOauthClients: {
      listByWorkspaceAndProvider: (input: {
        workspaceId: WorkspaceOauthClient["workspaceId"];
        providerKey: string;
      }) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(workspace_oauth_client)
              .where(
                and(
                  eq(workspace_oauth_client.workspaceId, input.workspaceId),
                  eq(workspace_oauth_client.providerKey, input.providerKey),
                ),
              )
              .orderBy(
                asc(workspace_oauth_client.updatedAt),
                asc(workspace_oauth_client.id),
              );

            return rows.map(toWorkspaceOauthClient);
          }),
        ),

      getById: (id: WorkspaceOauthClient["id"]) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(workspace_oauth_client)
              .where(eq(workspace_oauth_client.id, id))
              .limit(1);

            return optionFromNullable(rows[0] ? toWorkspaceOauthClient(rows[0]) : null);
          }),
        ),

      upsert: (oauthClient: WorkspaceOauthClient) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const clientMetadataJson = yield* parseNullableJson(
              oauthClient.clientMetadataJson,
              "workspace oauth client clientMetadataJson",
            );

            yield* db
              .insert(workspace_oauth_client)
              .values({
                ...oauthClient,
                clientMetadataJson,
              })
              .onConflictDoUpdate({
                target: workspace_oauth_client.id,
                set: {
                  workspaceId: oauthClient.workspaceId,
                  providerKey: oauthClient.providerKey,
                  label: oauthClient.label,
                  clientId: oauthClient.clientId,
                  clientSecretProviderId: oauthClient.clientSecretProviderId,
                  clientSecretHandle: oauthClient.clientSecretHandle,
                  clientMetadataJson,
                  createdAt: oauthClient.createdAt,
                  updatedAt: oauthClient.updatedAt,
                },
              });
          }),
        ),

      removeById: (id: WorkspaceOauthClient["id"]) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const deleted = yield* db
              .delete(workspace_oauth_client)
              .where(eq(workspace_oauth_client.id, id))
              .returning({ id: workspace_oauth_client.id });

            return deleted.length > 0;
          }),
        ),
    },

    providerAuthGrants: {
      listByWorkspaceId: (workspaceId: ProviderAuthGrant["workspaceId"]) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(provider_auth_grant)
              .where(eq(provider_auth_grant.workspaceId, workspaceId))
              .orderBy(
                asc(provider_auth_grant.updatedAt),
                asc(provider_auth_grant.id),
              );

            return rows.map(toProviderAuthGrant);
          }),
        ),

      listByWorkspaceActorAndProvider: (input: {
        workspaceId: ProviderAuthGrant["workspaceId"];
        actorAccountId: ProviderAuthGrant["actorAccountId"];
        providerKey: string;
      }) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(provider_auth_grant)
              .where(
                and(
                  eq(provider_auth_grant.workspaceId, input.workspaceId),
                  eq(provider_auth_grant.providerKey, input.providerKey),
                  nullableEquals(
                    provider_auth_grant.actorAccountId,
                    input.actorAccountId,
                  ),
                ),
              )
              .orderBy(
                asc(provider_auth_grant.updatedAt),
                asc(provider_auth_grant.id),
              );

            return rows.map(toProviderAuthGrant);
          }),
        ),

      getById: (id: ProviderAuthGrant["id"]) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(provider_auth_grant)
              .where(eq(provider_auth_grant.id, id))
              .limit(1);

            return optionFromNullable(rows[0] ? toProviderAuthGrant(rows[0]) : null);
          }),
        ),

      upsert: (grant: ProviderAuthGrant) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            yield* db
              .insert(provider_auth_grant)
              .values({
                ...grant,
                refreshTokenRef: grant.refreshToken,
                grantedScopes: grant.grantedScopes,
              })
              .onConflictDoUpdate({
                target: provider_auth_grant.id,
                set: {
                  workspaceId: grant.workspaceId,
                  actorAccountId: grant.actorAccountId,
                  providerKey: grant.providerKey,
                  oauthClientId: grant.oauthClientId,
                  tokenEndpoint: grant.tokenEndpoint,
                  clientAuthentication: grant.clientAuthentication,
                  headerName: grant.headerName,
                  prefix: grant.prefix,
                  refreshTokenRef: grant.refreshToken,
                  grantedScopes: grant.grantedScopes,
                  lastRefreshedAt: grant.lastRefreshedAt,
                  orphanedAt: grant.orphanedAt,
                  createdAt: grant.createdAt,
                  updatedAt: grant.updatedAt,
                },
              });
          }),
        ),

      removeById: (id: ProviderAuthGrant["id"]) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const deleted = yield* db
              .delete(provider_auth_grant)
              .where(eq(provider_auth_grant.id, id))
              .returning({ id: provider_auth_grant.id });

            return deleted.length > 0;
          }),
        ),
    },

    sourceAuthSessions: {
      listAll: () =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(source_auth_session)
              .orderBy(asc(source_auth_session.updatedAt), asc(source_auth_session.id));

            return rows.map(toSourceAuthSession);
          }),
        ),

      listByWorkspaceId: (workspaceId: SourceAuthSession["workspaceId"]) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(source_auth_session)
              .where(eq(source_auth_session.workspaceId, workspaceId))
              .orderBy(asc(source_auth_session.updatedAt), asc(source_auth_session.id));

            return rows.map(toSourceAuthSession);
          }),
        ),

      getById: (id: SourceAuthSession["id"]) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(source_auth_session)
              .where(eq(source_auth_session.id, id))
              .limit(1);

            return optionFromNullable(rows[0] ? toSourceAuthSession(rows[0]) : null);
          }),
        ),

      getByState: (state: SourceAuthSession["state"]) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(source_auth_session)
              .where(eq(source_auth_session.state, state))
              .limit(1);

            return optionFromNullable(rows[0] ? toSourceAuthSession(rows[0]) : null);
          }),
        ),

      getPendingByWorkspaceSourceAndActor: (input: {
        workspaceId: SourceAuthSession["workspaceId"];
        sourceId: SourceAuthSession["sourceId"];
        actorAccountId: SourceAuthSession["actorAccountId"];
        credentialSlot?: SourceAuthSession["credentialSlot"];
      }) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(source_auth_session)
              .where(
                and(
                  eq(source_auth_session.workspaceId, input.workspaceId),
                  eq(source_auth_session.sourceId, input.sourceId),
                  eq(source_auth_session.status, "pending"),
                  nullableEquals(
                    source_auth_session.actorAccountId,
                    input.actorAccountId,
                  ),
                  input.credentialSlot === undefined
                    ? undefined
                    : eq(source_auth_session.credentialSlot, input.credentialSlot),
                ),
              )
              .orderBy(asc(source_auth_session.updatedAt), asc(source_auth_session.id))
              .limit(1);

            return optionFromNullable(rows[0] ? toSourceAuthSession(rows[0]) : null);
          }),
        ),

      insert: (session: SourceAuthSession) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const sessionDataJson = yield* parseJson(
              session.sessionDataJson,
              "source auth session sessionDataJson",
            );

            yield* db.insert(source_auth_session).values({
              ...session,
              sessionDataJson,
            });
          }),
        ),

      update: (
        id: SourceAuthSession["id"],
        patch: Partial<
          Omit<SourceAuthSession, "id" | "workspaceId" | "sourceId" | "createdAt">
        >,
      ) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const updates: Partial<typeof source_auth_session.$inferInsert> = {
              ...(patch.actorAccountId !== undefined
                ? { actorAccountId: patch.actorAccountId }
                : {}),
              ...(patch.credentialSlot !== undefined
                ? { credentialSlot: patch.credentialSlot }
                : {}),
              ...(patch.executionId !== undefined ? { executionId: patch.executionId } : {}),
              ...(patch.interactionId !== undefined
                ? { interactionId: patch.interactionId }
                : {}),
              ...(patch.providerKind !== undefined
                ? { providerKind: patch.providerKind }
                : {}),
              ...(patch.status !== undefined ? { status: patch.status } : {}),
              ...(patch.state !== undefined ? { state: patch.state } : {}),
              ...(patch.errorText !== undefined ? { errorText: patch.errorText } : {}),
              ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
              ...(patch.updatedAt !== undefined ? { updatedAt: patch.updatedAt } : {}),
            };

            if (patch.sessionDataJson !== undefined) {
              updates.sessionDataJson = yield* parseJson(
                patch.sessionDataJson,
                "source auth session sessionDataJson",
              );
            }

            const rows = yield* db
              .update(source_auth_session)
              .set(updates)
              .where(eq(source_auth_session.id, id))
              .returning();

            return optionFromNullable(rows[0] ? toSourceAuthSession(rows[0]) : null);
          }),
        ),

      upsert: (session: SourceAuthSession) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const sessionDataJson = yield* parseJson(
              session.sessionDataJson,
              "source auth session sessionDataJson",
            );

            yield* db
              .insert(source_auth_session)
              .values({
                ...session,
                sessionDataJson,
              })
              .onConflictDoUpdate({
                target: source_auth_session.id,
                set: {
                  workspaceId: session.workspaceId,
                  sourceId: session.sourceId,
                  actorAccountId: session.actorAccountId,
                  credentialSlot: session.credentialSlot,
                  executionId: session.executionId,
                  interactionId: session.interactionId,
                  providerKind: session.providerKind,
                  status: session.status,
                  state: session.state,
                  sessionDataJson,
                  errorText: session.errorText,
                  completedAt: session.completedAt,
                  createdAt: session.createdAt,
                  updatedAt: session.updatedAt,
                },
              });
          }),
        ),

      removeByWorkspaceAndSourceId: (
        workspaceId: SourceAuthSession["workspaceId"],
        sourceId: SourceAuthSession["sourceId"],
      ) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const deleted = yield* db
              .delete(source_auth_session)
              .where(
                and(
                  eq(source_auth_session.workspaceId, workspaceId),
                  eq(source_auth_session.sourceId, sourceId),
                ),
              )
              .returning({ id: source_auth_session.id });

            return deleted.length > 0;
          }),
        ),
    },

    secretMaterials: {
      getById: (id: SecretMaterial["id"]) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(secret_material)
              .where(eq(secret_material.id, id))
              .limit(1);

            return optionFromNullable(rows[0] ? toSecretMaterial(rows[0]) : null);
          }),
        ),

      listAll: () =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select({
                id: secret_material.id,
                providerId: secret_material.providerId,
                name: secret_material.name,
                purpose: secret_material.purpose,
                createdAt: secret_material.createdAt,
                updatedAt: secret_material.updatedAt,
              })
              .from(secret_material)
              .orderBy(desc(secret_material.updatedAt), desc(secret_material.id));

            return rows satisfies ReadonlyArray<SecretMaterialSummary>;
          }),
        ),

      upsert: (material: SecretMaterial) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            yield* db
              .insert(secret_material)
              .values(material)
              .onConflictDoUpdate({
                target: secret_material.id,
                set: {
                  name: material.name,
                  purpose: material.purpose,
                  providerId: material.providerId,
                  handle: material.handle,
                  value: material.value,
                  createdAt: material.createdAt,
                  updatedAt: material.updatedAt,
                },
              });
          }),
        ),

      updateById: (
        id: SecretMaterial["id"],
        update: { name?: string | null; value?: string },
      ) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .update(secret_material)
              .set({
                ...(update.name !== undefined ? { name: update.name } : {}),
                ...(update.value !== undefined ? { value: update.value } : {}),
                updatedAt: Date.now(),
              })
              .where(eq(secret_material.id, id))
              .returning({
                id: secret_material.id,
                providerId: secret_material.providerId,
                name: secret_material.name,
                purpose: secret_material.purpose,
                createdAt: secret_material.createdAt,
                updatedAt: secret_material.updatedAt,
              });

            return optionFromNullable(rows[0] ?? null);
          }),
        ),

      removeById: (id: SecretMaterial["id"]) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const deleted = yield* db
              .delete(secret_material)
              .where(eq(secret_material.id, id))
              .returning({ id: secret_material.id });

            return deleted.length > 0;
          }),
        ),
    },

    executions: {
      getById: (executionId: Execution["id"]) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(execution)
              .where(eq(execution.id, executionId))
              .limit(1);

            return optionFromNullable(rows[0] ? toExecution(rows[0]) : null);
          }),
        ),

      getByWorkspaceAndId: (
        workspaceId: Execution["workspaceId"],
        executionId: Execution["id"],
      ) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(execution)
              .where(
                and(
                  eq(execution.workspaceId, workspaceId),
                  eq(execution.id, executionId),
                ),
              )
              .limit(1);

            return optionFromNullable(rows[0] ? toExecution(rows[0]) : null);
          }),
        ),

      listByWorkspaceId: (workspaceId: Execution["workspaceId"]) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(execution)
              .where(eq(execution.workspaceId, workspaceId))
              .orderBy(desc(execution.createdAt));

            return rows.map(toExecution);
          }),
        ),

      insert: (nextExecution: Execution) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const resultJson = yield* parseNullableJson(
              nextExecution.resultJson,
              "execution resultJson",
            );
            const logsJson = yield* parseNullableJson(
              nextExecution.logsJson,
              "execution logsJson",
            );

            yield* db.insert(execution).values({
              ...nextExecution,
              executionSessionId: nextExecution.executionSessionId,
              resultJson,
              logsJson,
            });
          }),
        ),

      update: (
        executionId: Execution["id"],
        patch: Partial<
          Omit<Execution, "id" | "workspaceId" | "createdByAccountId" | "createdAt">
        >,
      ) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const updates: Partial<typeof execution.$inferInsert> = {
              ...(patch.status !== undefined ? { status: patch.status } : {}),
              ...(patch.code !== undefined ? { code: patch.code } : {}),
              ...(patch.executionSessionId !== undefined
                ? { executionSessionId: patch.executionSessionId }
                : {}),
              ...(patch.errorText !== undefined ? { errorText: patch.errorText } : {}),
              ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
              ...(patch.completedAt !== undefined
                ? { completedAt: patch.completedAt }
                : {}),
              ...(patch.updatedAt !== undefined ? { updatedAt: patch.updatedAt } : {}),
            };

            if (patch.resultJson !== undefined) {
              updates.resultJson = yield* parseNullableJson(
                patch.resultJson,
                "execution resultJson",
              );
            }

            if (patch.logsJson !== undefined) {
              updates.logsJson = yield* parseNullableJson(
                patch.logsJson,
                "execution logsJson",
              );
            }

            const rows = yield* db
              .update(execution)
              .set(updates)
              .where(eq(execution.id, executionId))
              .returning();

            return optionFromNullable(rows[0] ? toExecution(rows[0]) : null);
          }),
        ),
    },

    executionInteractions: {
      getById: (interactionId: ExecutionInteraction["id"]) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(execution_interaction)
              .where(eq(execution_interaction.id, interactionId))
              .limit(1);

            return optionFromNullable(
              rows[0] ? toExecutionInteraction(rows[0]) : null,
            );
          }),
        ),

      listByExecutionId: (executionId: ExecutionInteraction["executionId"]) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(execution_interaction)
              .where(eq(execution_interaction.executionId, executionId))
              .orderBy(
                desc(execution_interaction.updatedAt),
                desc(execution_interaction.id),
              );

            return rows.map(toExecutionInteraction);
          }),
        ),

      getPendingByExecutionId: (executionId: ExecutionInteraction["executionId"]) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(execution_interaction)
              .where(
                and(
                  eq(execution_interaction.executionId, executionId),
                  eq(execution_interaction.status, "pending"),
                ),
              )
              .orderBy(
                desc(execution_interaction.updatedAt),
                desc(execution_interaction.id),
              )
              .limit(1);

            return optionFromNullable(
              rows[0] ? toExecutionInteraction(rows[0]) : null,
            );
          }),
        ),

      insert: (interaction: ExecutionInteraction) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const payloadJson = yield* parseJson(
              interaction.payloadJson,
              "execution interaction payloadJson",
            );
            const responseJson = yield* parseNullableJson(
              interaction.responseJson,
              "execution interaction responseJson",
            );
            const responsePrivateJson = yield* parseNullableJson(
              interaction.responsePrivateJson,
              "execution interaction responsePrivateJson",
            );

            yield* db.insert(execution_interaction).values({
              ...interaction,
              payloadJson,
              responseJson,
              responsePrivateJson,
            });
          }),
        ),

      update: (
        interactionId: ExecutionInteraction["id"],
        patch: Partial<
          Omit<ExecutionInteraction, "id" | "executionId" | "createdAt">
        >,
      ) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const updates: Partial<typeof execution_interaction.$inferInsert> = {
              ...(patch.status !== undefined ? { status: patch.status } : {}),
              ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
              ...(patch.purpose !== undefined ? { purpose: patch.purpose } : {}),
              ...(patch.updatedAt !== undefined ? { updatedAt: patch.updatedAt } : {}),
            };

            if (patch.payloadJson !== undefined) {
              updates.payloadJson = yield* parseJson(
                patch.payloadJson,
                "execution interaction payloadJson",
              );
            }
            if (patch.responseJson !== undefined) {
              updates.responseJson = yield* parseNullableJson(
                patch.responseJson,
                "execution interaction responseJson",
              );
            }
            if (patch.responsePrivateJson !== undefined) {
              updates.responsePrivateJson = yield* parseNullableJson(
                patch.responsePrivateJson,
                "execution interaction responsePrivateJson",
              );
            }

            const rows = yield* db
              .update(execution_interaction)
              .set(updates)
              .where(eq(execution_interaction.id, interactionId))
              .returning();

            return optionFromNullable(
              rows[0] ? toExecutionInteraction(rows[0]) : null,
            );
          }),
        ),
    },

    executionSteps: {
      getByExecutionAndSequence: (
        executionId: ExecutionStep["executionId"],
        sequence: ExecutionStep["sequence"],
      ) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(execution_step)
              .where(
                and(
                  eq(execution_step.executionId, executionId),
                  eq(execution_step.sequence, sequence),
                ),
              )
              .limit(1);

            return optionFromNullable(rows[0] ? toExecutionStep(rows[0]) : null);
          }),
        ),

      listByExecutionId: (executionId: ExecutionStep["executionId"]) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select()
              .from(execution_step)
              .where(eq(execution_step.executionId, executionId))
              .orderBy(asc(execution_step.sequence), desc(execution_step.updatedAt));

            return rows.map(toExecutionStep);
          }),
        ),

      insert: (step: ExecutionStep) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const argsJson = yield* parseJson(
              step.argsJson,
              "execution step argsJson",
            );
            const resultJson = yield* parseNullableJson(
              step.resultJson,
              "execution step resultJson",
            );

            yield* db.insert(execution_step).values({
              ...step,
              argsJson,
              resultJson,
            });
          }),
        ),

      deleteByExecutionId: (executionId: ExecutionStep["executionId"]) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            yield* db
              .delete(execution_step)
              .where(eq(execution_step.executionId, executionId));
          }),
        ),

      updateByExecutionAndSequence: (
        executionId: ExecutionStep["executionId"],
        sequence: ExecutionStep["sequence"],
        patch: Partial<
          Omit<ExecutionStep, "id" | "executionId" | "sequence" | "createdAt">
        >,
      ) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const updates: Partial<typeof execution_step.$inferInsert> = {
              ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
              ...(patch.status !== undefined ? { status: patch.status } : {}),
              ...(patch.path !== undefined ? { path: patch.path } : {}),
              ...(patch.errorText !== undefined ? { errorText: patch.errorText } : {}),
              ...(patch.interactionId !== undefined
                ? { interactionId: patch.interactionId }
                : {}),
              ...(patch.updatedAt !== undefined ? { updatedAt: patch.updatedAt } : {}),
            };

            if (patch.argsJson !== undefined) {
              updates.argsJson = yield* parseJson(
                patch.argsJson,
                "execution step argsJson",
              );
            }
            if (patch.resultJson !== undefined) {
              updates.resultJson = yield* parseNullableJson(
                patch.resultJson,
                "execution step resultJson",
              );
            }

            const rows = yield* db
              .update(execution_step)
              .set(updates)
              .where(
                and(
                  eq(execution_step.executionId, executionId),
                  eq(execution_step.sequence, sequence),
                ),
              )
              .returning();

            return optionFromNullable(rows[0] ? toExecutionStep(rows[0]) : null);
          }),
        ),
    },
  };
};

export type LocalEngineStore = ReturnType<typeof createSqliteEngineStore>;

export const createLocalEnginePersistence = (
  context: ResolvedLocalWorkspaceContext,
): Effect.Effect<LocalEnginePersistence, Error> =>
  Effect.gen(function* () {
    yield* ensureWorkspaceStateDirectory(context);
    const runtime = ManagedRuntime.make(
      makeWorkspaceCatalogDbLayer(workspaceDbPath(context)),
    );

    yield* Effect.tryPromise({
      try: () => runtime.runPromise(SqlClient.SqlClient.pipe(Effect.asVoid)),
      catch: toError,
    }).pipe(
      Effect.tapError(() =>
        Effect.promise(() => runtime.dispose()).pipe(Effect.ignore),
      ),
    );

    return {
      rows: createSqliteEngineStore(runtime),
      close: () => runtime.dispose(),
    } satisfies LocalEnginePersistence;
  });
