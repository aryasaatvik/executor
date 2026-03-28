import * as Effect from "effect/Effect";

import * as Option from "effect/Option";
import type { SearchHit } from "@executor/codemode-core";

import {
  closeExecutionSession,
  createExecution,
  getExecution,
  listExecutionSteps,
  listExecutions,
  resumeExecution,
  SourceCatalogStore,
} from "@executor/core/services/execution";
import { discoverSource } from "@executor/core/services/sources/source-discovery";
import { SourceStore as ControlPlaneSourceStore } from "@executor/core/services/sources/source-service";
import {
  discoverSourceInspectionTools,
  getSourceInspection,
  getSourceInspectionToolDetail,
} from "@executor/core/services/sources/source-inspection";
import {
  createSource,
  updateSource,
} from "@executor/core/services/sources/source-operations";
import {
  SourceAuthService,
  type ExecutorAddSourceInput,
} from "@executor/core/services/sources/source-auth-service";
import {
  createPolicy,
  getPolicy,
  listPolicies,
  removePolicy,
  updatePolicy,
} from "@executor/core/services/policy/policies-operations";
import { requireRuntimeLocalWorkspace } from "@executor/core/services/engine/runtime-context";
import { WorkspaceConfigStore as ControlPlaneWorkspaceConfigStore } from "@executor/core/services/engine/local-storage";
import { SecretMaterialStore as ControlPlaneSecretMaterialStore } from "@executor/core/services/engine/secret-material-store";
import {
  type ConnectSourcePayload,
  sourceAdapterRequiresInteractiveConnect,
} from "@executor/core/services/engine/source-adapters";
import {
  SecretMaterialIdSchema,
  type ToolSearchBackendMode,
  type ToolSearchMode,
  type ToolSearchResultSet,
  WorkspaceOauthClientIdSchema,
} from "@executor/core/model";
import {
  createLocalWorkspaceSourceCatalog,
  ENV_SECRET_PROVIDER_ID,
  KEYCHAIN_SECRET_PROVIDER_ID,
  LOCAL_SECRET_PROVIDER_ID,
  parseSecretStoreProviderId,
  resolveDefaultSecretStoreProviderId,
} from "@executor/world-local";
import { validateSemanticSearchConfigForWrite } from "../api/local/semantic-search-config";
import type { InstanceConfig, SecretProvider } from "../api/local/api";

import { ExecutorRpcs, ExecutorRpcError } from "./contract";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const rpcError = (operation: string, message: string, code: ExecutorRpcError["code"]) =>
  new ExecutorRpcError({ operation, message, code });

const resolveWorkspace = (operation: string) =>
  requireRuntimeLocalWorkspace().pipe(
    Effect.mapError(() =>
      rpcError(operation, "No active local workspace", "unauthorized"),
    ),
  );

const sourceStoreRpcError = (operation: string, cause: unknown): ExecutorRpcError => {
  const message = cause instanceof Error ? cause.message : String(cause);

  if (cause instanceof Error && cause.message.startsWith("Source not found:")) {
    return rpcError(operation, "Source not found", "not_found");
  }

  return rpcError(operation, message, "storage");
};

const mapError = (operation: string) => <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, ExecutorRpcError, R> =>
  effect.pipe(
    Effect.catchAll((cause: E) => {
      if (
        cause !== null &&
        typeof cause === "object" &&
        "_tag" in (cause as object) &&
        "message" in (cause as object)
      ) {
        const e = cause as unknown as { _tag: string; operation?: string; message: string };
        const code =
          e._tag === "EngineBadRequestError" ? "bad_request" as const
            : e._tag === "EngineUnauthorizedError" ? "unauthorized" as const
              : e._tag === "EngineForbiddenError" ? "forbidden" as const
                : e._tag === "EngineNotFoundError" ? "not_found" as const
                  : "storage" as const;
        return Effect.fail(rpcError(e.operation ?? operation, e.message, code));
      }

      const message = cause instanceof Error ? cause.message : String(cause);
      return Effect.fail(rpcError(operation, message, "storage"));
    }),
  );

const normalizeSearchLimit = (limit: number | undefined): number => {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return 10;
  }

  return Math.min(100, Math.max(1, Math.trunc(limit)));
};

const parseSearchQuery = (query: string): { mode: ToolSearchMode; cleanQuery: string } => {
  if (query.startsWith("+")) {
    return { mode: "exact", cleanQuery: query.slice(1).trim() };
  }

  return { mode: "search", cleanQuery: query.trim() };
};

const toolResultFromIndexEntry = (
  tool: {
    path: string;
    searchNamespace: string;
    descriptor: {
      sourceKey: string;
      description?: string;
      contract?: {
        inputTypePreview?: string;
        outputTypePreview?: string;
      };
    };
  },
  score: number,
) => ({
  path: tool.path,
  score,
  sourceKey: tool.descriptor.sourceKey,
  namespace: tool.searchNamespace,
  ...(tool.descriptor.description !== undefined
    ? { description: tool.descriptor.description }
    : {}),
  ...(tool.descriptor.contract?.inputTypePreview !== undefined
    ? { inputTypePreview: tool.descriptor.contract.inputTypePreview }
    : {}),
  ...(tool.descriptor.contract?.outputTypePreview !== undefined
    ? { outputTypePreview: tool.descriptor.contract.outputTypePreview }
    : {}),
});

const buildToolSearchResultSet = (input: {
  query: string;
  source?: string | null | undefined;
  namespace?: string | null | undefined;
  limit?: number | undefined;
}, output: {
  mode: ToolSearchMode;
  searchMode: ToolSearchBackendMode;
  results: ToolSearchResultSet["results"];
}): ToolSearchResultSet => ({
  meta: {
    query: input.query,
    mode: output.mode,
    searchMode: output.searchMode,
    total: output.results.length,
    source: input.source ?? null,
    namespace: input.namespace ?? null,
    limit: normalizeSearchLimit(input.limit),
  },
  results: output.results,
});
// ---------------------------------------------------------------------------
// Handler layer
// ---------------------------------------------------------------------------

export const ExecutorRpcHandlerLive = ExecutorRpcs.toLayer(
  ExecutorRpcs.of({
    // -- Sources -----------------------------------------------------------

    ListSources: () =>
      resolveWorkspace("ListSources").pipe(
        Effect.flatMap((ws) =>
          Effect.gen(function* () {
            const sourceStore = yield* ControlPlaneSourceStore;
            return yield* sourceStore.loadSourcesInWorkspace(
              ws.installation.workspaceId,
              { actorAccountId: ws.installation.accountId },
            ).pipe(
              Effect.mapError((cause) => sourceStoreRpcError("ListSources", cause)),
            );
          }),
        ),
      ),

    GetSource: ({ sourceId }) =>
      resolveWorkspace("GetSource").pipe(
        Effect.flatMap((ws) =>
          Effect.gen(function* () {
            const sourceStore = yield* ControlPlaneSourceStore;
            return yield* sourceStore.loadSourceById({
              workspaceId: ws.installation.workspaceId,
              sourceId,
              actorAccountId: ws.installation.accountId,
            }).pipe(
              Effect.mapError((cause) => sourceStoreRpcError("GetSource", cause)),
            );
          }),
        ),
      ),

    CreateSource: (payload) =>
      resolveWorkspace("CreateSource").pipe(
        Effect.flatMap((ws) =>
          createSource({ workspaceId: ws.installation.workspaceId, accountId: ws.installation.accountId, payload }),
        ),
        mapError("CreateSource"),
      ),

    UpdateSource: ({ sourceId, update }) =>
      resolveWorkspace("UpdateSource").pipe(
        Effect.flatMap((ws) =>
          updateSource({
            workspaceId: ws.installation.workspaceId,
            sourceId,
            accountId: ws.installation.accountId,
            payload: update,
          }),
        ),
        mapError("UpdateSource"),
      ),

    RemoveSource: ({ sourceId }) =>
      resolveWorkspace("RemoveSource").pipe(
        Effect.flatMap((ws) =>
          Effect.gen(function* () {
            const sourceStore = yield* ControlPlaneSourceStore;
            const removed = yield* sourceStore.removeSourceById({
              workspaceId: ws.installation.workspaceId,
              sourceId,
            }).pipe(
              Effect.mapError((cause) => sourceStoreRpcError("RemoveSource", cause)),
            );

            return { removed };
          }),
        ),
      ),

    DiscoverSource: (payload) =>
      discoverSource({
        url: payload.url,
        probeAuth: payload.probeAuth,
      }).pipe(mapError("DiscoverSource")),

    ConnectSource: (payload) =>
      resolveWorkspace("ConnectSource").pipe(
        Effect.flatMap((ws) =>
          Effect.gen(function* () {
            const sourceAuthService = yield* SourceAuthService;
            const p = payload as ConnectSourcePayload;
            if (p.kind === undefined || sourceAdapterRequiresInteractiveConnect(p.kind)) {
              const mcp = p as Extract<ConnectSourcePayload, { kind?: "mcp" }>;
              return yield* sourceAuthService.connectMcpSource({
                workspaceId: ws.installation.workspaceId,
                actorAccountId: ws.installation.accountId,
                endpoint: mcp.endpoint,
                name: mcp.name,
                namespace: mcp.namespace,
                transport: mcp.transport,
                queryParams: mcp.queryParams,
                headers: mcp.headers,
                command: mcp.command,
                args: mcp.args,
                env: mcp.env,
                cwd: mcp.cwd,
                baseUrl: null,
              });
            }

            const baseInput = {
              workspaceId: ws.installation.workspaceId,
              actorAccountId: ws.installation.accountId,
              executionId: null,
              interactionId: null,
            };

            if (p.kind === "openapi") {
              const openapi = p as Extract<ConnectSourcePayload, { kind: "openapi" }>;
              return yield* sourceAuthService.addExecutorSource(
                { ...baseInput, ...openapi } satisfies ExecutorAddSourceInput,
                { baseUrl: null },
              );
            }

            if (p.kind === "graphql") {
              const graphql = p as Extract<ConnectSourcePayload, { kind: "graphql" }>;
              return yield* sourceAuthService.addExecutorSource(
                { ...baseInput, ...graphql } satisfies ExecutorAddSourceInput,
                { baseUrl: null },
              );
            }

            if (p.kind === "google_discovery") {
              const googleDiscovery = p as Extract<ConnectSourcePayload, { kind: "google_discovery" }>;
              return yield* sourceAuthService.addExecutorSource(
                {
                  ...baseInput,
                  kind: "google_discovery",
                  service: googleDiscovery.service,
                  version: googleDiscovery.version,
                  discoveryUrl: googleDiscovery.discoveryUrl,
                  scopes: googleDiscovery.scopes,
                  workspaceOauthClientId:
                    googleDiscovery.workspaceOauthClientId == null
                      ? googleDiscovery.workspaceOauthClientId
                      : WorkspaceOauthClientIdSchema.make(googleDiscovery.workspaceOauthClientId),
                  oauthClient: googleDiscovery.oauthClient,
                  name: googleDiscovery.name,
                  namespace: googleDiscovery.namespace,
                  importAuthPolicy: googleDiscovery.importAuthPolicy,
                  importAuth: googleDiscovery.importAuth,
                  auth: googleDiscovery.auth,
                } satisfies ExecutorAddSourceInput,
                { baseUrl: null },
              );
            }

            const mcp = p as Extract<ConnectSourcePayload, { kind?: "mcp" }>;
            return yield* sourceAuthService.addExecutorSource(
              { ...baseInput, ...mcp } satisfies ExecutorAddSourceInput,
              { baseUrl: null },
            );
          }),
        ),
        mapError("ConnectSource"),
      ),

    ConnectSourceBatch: (payload) =>
      resolveWorkspace("ConnectSourceBatch").pipe(
        Effect.flatMap((ws) =>
          Effect.gen(function* () {
            const sourceAuthService = yield* SourceAuthService;
            return yield* sourceAuthService.connectGoogleDiscoveryBatch({
              workspaceId: ws.installation.workspaceId,
              actorAccountId: ws.installation.accountId,
              executionId: null,
              interactionId: null,
              workspaceOauthClientId: payload.workspaceOauthClientId,
              sources: payload.sources,
              baseUrl: null,
            });
          }),
        ),
        mapError("ConnectSourceBatch"),
      ),

    // -- Source inspection --------------------------------------------------

    GetSourceInspection: ({ sourceId }) =>
      resolveWorkspace("GetSourceInspection").pipe(
        Effect.flatMap((ws) =>
          getSourceInspection({ workspaceId: ws.installation.workspaceId, sourceId }),
        ),
        mapError("GetSourceInspection"),
      ),

    GetSourceInspectionToolDetail: ({ sourceId, toolPath }) =>
      resolveWorkspace("GetSourceInspectionToolDetail").pipe(
        Effect.flatMap((ws) =>
          getSourceInspectionToolDetail({ workspaceId: ws.installation.workspaceId, sourceId, toolPath }),
        ),
        mapError("GetSourceInspectionToolDetail"),
      ),

    DiscoverSourceInspectionTools: ({ sourceId, discover }) =>
      resolveWorkspace("DiscoverSourceInspectionTools").pipe(
        Effect.flatMap((ws) =>
          discoverSourceInspectionTools({
            workspaceId: ws.installation.workspaceId,
            sourceId,
            payload: discover,
          }),
        ),
        mapError("DiscoverSourceInspectionTools"),
      ),

    // -- Executions --------------------------------------------------------

    ListExecutions: () =>
      resolveWorkspace("ListExecutions").pipe(
        Effect.flatMap((ws) => listExecutions({ workspaceId: ws.installation.workspaceId })),
        mapError("ListExecutions"),
      ),

    CreateExecution: (payload) =>
      resolveWorkspace("CreateExecution").pipe(
        Effect.flatMap((ws) =>
          createExecution({
            workspaceId: ws.installation.workspaceId,
            payload,
            createdByAccountId: ws.installation.accountId,
          }),
        ),
        mapError("CreateExecution"),
      ),

    GetExecution: ({ executionId }) =>
      resolveWorkspace("GetExecution").pipe(
        Effect.flatMap((ws) =>
          getExecution({ workspaceId: ws.installation.workspaceId, executionId }),
        ),
        mapError("GetExecution"),
      ),

    ResumeExecution: ({ executionId, resume }) =>
      resolveWorkspace("ResumeExecution").pipe(
        Effect.flatMap((ws) =>
          resumeExecution({
            workspaceId: ws.installation.workspaceId,
            executionId,
            payload: resume,
            resumedByAccountId: ws.installation.accountId,
          }),
        ),
        mapError("ResumeExecution"),
      ),

    ListExecutionSteps: ({ executionId }) =>
      resolveWorkspace("ListExecutionSteps").pipe(
        Effect.flatMap((ws) =>
          listExecutionSteps({ workspaceId: ws.installation.workspaceId, executionId }),
        ),
        mapError("ListExecutionSteps"),
      ),

    CloseExecutionSession: ({ executionSessionId }) =>
      resolveWorkspace("CloseExecutionSession").pipe(
        Effect.flatMap((ws) =>
          closeExecutionSession({
            workspaceId: ws.installation.workspaceId,
            executionSessionId,
            accountId: ws.installation.accountId,
          }),
        ),
        mapError("CloseExecutionSession"),
      ),

    // -- Secrets -----------------------------------------------------------

    ListSecrets: () =>
      resolveWorkspace("ListSecrets").pipe(
        Effect.flatMap((ws) =>
          Effect.gen(function* () {
            const secretMaterialStore = yield* ControlPlaneSecretMaterialStore;
            const sourceStore = yield* ControlPlaneSourceStore;
            const rows = yield* secretMaterialStore.listAll();
            const linkedSourcesMap = yield* sourceStore.listLinkedSecretSourcesInWorkspace(
              ws.installation.workspaceId,
              { actorAccountId: ws.installation.accountId },
            );
            return rows.map((row) => ({
              ...row,
              linkedSources: linkedSourcesMap.get(row.id) ?? [],
            }));
          }),
        ),
        mapError("ListSecrets"),
      ),

    CreateSecret: (payload) =>
      Effect.gen(function* () {
        const name = payload.name.trim();
        const value = payload.value;
        const purpose = payload.purpose ?? "auth_material";
        const requestedProviderId = payload.providerId === undefined
          ? null
          : parseSecretStoreProviderId(payload.providerId);

        if (name.length === 0) {
          return yield* Effect.fail(
            rpcError("CreateSecret", "Secret name is required.", "bad_request"),
          );
        }
        if (payload.providerId !== undefined && requestedProviderId === null) {
          return yield* Effect.fail(
            rpcError("CreateSecret", `Unsupported secret provider: ${payload.providerId}`, "bad_request"),
          );
        }

        const secretMaterialStore = yield* ControlPlaneSecretMaterialStore;
        const ref = yield* secretMaterialStore.store({
          name,
          purpose,
          value,
          ...(requestedProviderId ? { providerId: requestedProviderId } : {}),
        });
        const secretId = SecretMaterialIdSchema.make(ref.handle);
        const created = yield* secretMaterialStore.getById(secretId);

        if (Option.isNone(created)) {
          return yield* Effect.fail(
            rpcError("CreateSecret", `Created secret not found: ${ref.handle}`, "storage"),
          );
        }

        return {
          id: created.value.id,
          name: created.value.name,
          providerId: created.value.providerId,
          purpose: created.value.purpose,
          createdAt: created.value.createdAt,
          updatedAt: created.value.updatedAt,
        };
      }).pipe(mapError("CreateSecret")),

    UpdateSecret: ({ secretId, update }) =>
      Effect.gen(function* () {
        const id = SecretMaterialIdSchema.make(secretId);
        const secretMaterialStore = yield* ControlPlaneSecretMaterialStore;

        const existing = yield* secretMaterialStore.getById(id);
        if (Option.isNone(existing)) {
          return yield* Effect.fail(
            rpcError("UpdateSecret", `Secret not found: ${secretId}`, "not_found"),
          );
        }

        const changes: { name?: string | null; value?: string } = {};
        if (update.name !== undefined) changes.name = update.name.trim() || null;
        if (update.value !== undefined) changes.value = update.value;

        const updated = yield* secretMaterialStore.update({
          ref: {
            providerId: existing.value.providerId,
            handle: existing.value.id,
          },
          ...changes,
        });

        return {
          id: updated.id,
          providerId: updated.providerId,
          name: updated.name,
          purpose: updated.purpose,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        };
      }).pipe(mapError("UpdateSecret")),

    DeleteSecret: ({ secretId }) =>
      Effect.gen(function* () {
        const id = SecretMaterialIdSchema.make(secretId);
        const secretMaterialStore = yield* ControlPlaneSecretMaterialStore;

        const existing = yield* secretMaterialStore.getById(id);
        if (Option.isNone(existing)) {
          return yield* Effect.fail(
            rpcError("DeleteSecret", `Secret not found: ${secretId}`, "not_found"),
          );
        }

        const removed = yield* secretMaterialStore.remove({
          providerId: existing.value.providerId,
          handle: existing.value.id,
        });

        if (!removed) {
          return yield* Effect.fail(
            rpcError("DeleteSecret", `Failed removing secret: ${secretId}`, "storage"),
          );
        }

        return { removed: true };
      }).pipe(mapError("DeleteSecret")),

    // -- Policies ----------------------------------------------------------

    ListPolicies: () =>
      resolveWorkspace("ListPolicies").pipe(
        Effect.flatMap((ws) => listPolicies(ws.installation.workspaceId)),
        mapError("ListPolicies"),
      ),

    CreatePolicy: (payload) =>
      resolveWorkspace("CreatePolicy").pipe(
        Effect.flatMap((ws) => createPolicy({ workspaceId: ws.installation.workspaceId, payload })),
        mapError("CreatePolicy"),
      ),

    GetPolicy: ({ policyId }) =>
      resolveWorkspace("GetPolicy").pipe(
        Effect.flatMap((ws) => getPolicy({ workspaceId: ws.installation.workspaceId, policyId })),
        mapError("GetPolicy"),
      ),

    UpdatePolicy: ({ policyId, update }) =>
      resolveWorkspace("UpdatePolicy").pipe(
        Effect.flatMap((ws) =>
          updatePolicy({ workspaceId: ws.installation.workspaceId, policyId, payload: update }),
        ),
        mapError("UpdatePolicy"),
      ),

    RemovePolicy: ({ policyId }) =>
      resolveWorkspace("RemovePolicy").pipe(
        Effect.flatMap((ws) => removePolicy({ workspaceId: ws.installation.workspaceId, policyId })),
        mapError("RemovePolicy"),
      ),

    // -- Local -------------------------------------------------------------

    GetInstallation: () =>
      resolveWorkspace("GetInstallation").pipe(
        Effect.map((ws) => ws.installation),
        mapError("GetInstallation"),
      ),

    GetConfig: () =>
      Effect.gen(function* () {
        const ws = yield* resolveWorkspace("GetConfig");
        const workspaceConfigStore = yield* ControlPlaneWorkspaceConfigStore;
        const loadedConfig = yield* workspaceConfigStore.load(ws.context);

        const explicitDefaultStoreProvider =
          parseSecretStoreProviderId(process.env["EXECUTOR_SECRET_STORE_PROVIDER"]);
        const providers: SecretProvider[] = [
          { id: LOCAL_SECRET_PROVIDER_ID, name: "Local store", canStore: true },
        ];

        if (process.platform === "darwin" || process.platform === "linux") {
          providers.push({
            id: KEYCHAIN_SECRET_PROVIDER_ID,
            name: process.platform === "darwin" ? "macOS Keychain" : "Desktop Keyring",
            canStore:
              process.platform === "darwin"
              || explicitDefaultStoreProvider === KEYCHAIN_SECRET_PROVIDER_ID,
          });
        }

        providers.push({ id: ENV_SECRET_PROVIDER_ID, name: "Environment variable", canStore: false });

        const resolvedDefaultStoreProvider = yield* resolveDefaultSecretStoreProviderId({
          storeProviderId: explicitDefaultStoreProvider ?? undefined,
        });

        return {
          platform: process.platform,
          secretProviders: providers,
          defaultSecretStoreProvider: resolvedDefaultStoreProvider,
          semanticSearch: loadedConfig.config?.semanticSearch ?? null,
        } satisfies InstanceConfig;
      }).pipe(mapError("GetConfig")),

    UpdateConfig: (payload) =>
      Effect.gen(function* () {
        const ws = yield* resolveWorkspace("UpdateConfig");
        const workspaceConfigStore = yield* ControlPlaneWorkspaceConfigStore;
        const loadedConfig = yield* workspaceConfigStore.load(ws.context);

        const semanticSearchValidationError = validateSemanticSearchConfigForWrite(
          payload.semanticSearch,
        );
        if (semanticSearchValidationError) {
          return yield* Effect.fail(
            rpcError("UpdateConfig", semanticSearchValidationError, "bad_request"),
          );
        }

        const currentProjectConfig = loadedConfig.projectConfig ?? {};
        const nextProjectConfig = {
          ...currentProjectConfig,
          semanticSearch: payload.semanticSearch,
        };

        yield* workspaceConfigStore.writeProject({
          context: ws.context,
          config: nextProjectConfig,
        });

        // Re-load to return the updated config
        const explicitDefaultStoreProvider =
          parseSecretStoreProviderId(process.env["EXECUTOR_SECRET_STORE_PROVIDER"]);
        const providers: SecretProvider[] = [
          { id: LOCAL_SECRET_PROVIDER_ID, name: "Local store", canStore: true },
        ];

        if (process.platform === "darwin" || process.platform === "linux") {
          providers.push({
            id: KEYCHAIN_SECRET_PROVIDER_ID,
            name: process.platform === "darwin" ? "macOS Keychain" : "Desktop Keyring",
            canStore:
              process.platform === "darwin"
              || explicitDefaultStoreProvider === KEYCHAIN_SECRET_PROVIDER_ID,
          });
        }

        providers.push({ id: ENV_SECRET_PROVIDER_ID, name: "Environment variable", canStore: false });

        const resolvedDefaultStoreProvider = yield* resolveDefaultSecretStoreProviderId({
          storeProviderId: explicitDefaultStoreProvider ?? undefined,
        });

        return {
          platform: process.platform,
          secretProviders: providers,
          defaultSecretStoreProvider: resolvedDefaultStoreProvider,
          semanticSearch: payload.semanticSearch,
        } satisfies InstanceConfig;
      }).pipe(mapError("UpdateConfig")),

    // -- OAuth -------------------------------------------------------------

    StartSourceOAuth: (payload) =>
      resolveWorkspace("StartSourceOAuth").pipe(
        Effect.flatMap((ws) =>
          Effect.gen(function* () {
            const sourceAuthService = yield* SourceAuthService;
            return yield* sourceAuthService.startSourceOAuthSession({
              workspaceId: ws.installation.workspaceId,
              actorAccountId: ws.installation.accountId,
              baseUrl: null,
              displayName: payload.name,
              provider: {
                kind: payload.provider,
                endpoint: payload.endpoint,
                transport: payload.transport,
                queryParams: payload.queryParams,
                headers: payload.headers,
              },
            });
          }),
        ),
        mapError("StartSourceOAuth"),
      ),

    SearchTools: (payload) =>
      resolveWorkspace("SearchTools").pipe(
        Effect.flatMap((ws) =>
          Effect.gen(function* () {
            const sourceCatalogStore = yield* SourceCatalogStore;
            const catalog = createLocalWorkspaceSourceCatalog({
              runtimeLocalWorkspace: ws,
            });

            const limit = normalizeSearchLimit(payload.limit);
            const source = payload.source ?? undefined;
            const namespace = payload.namespace ?? undefined;
            const { mode, cleanQuery } = parseSearchQuery(payload.query);

            if (cleanQuery.length === 0) {
              return buildToolSearchResultSet(
                payload,
                {
                  mode: mode === "exact" ? "exact" : "search",
                  searchMode: "fts",
                  results: [],
                },
              );
            }

            if (mode === "exact") {
              const tool = yield* sourceCatalogStore.loadWorkspaceSourceCatalogToolByPath({
                workspaceId: ws.installation.workspaceId,
                path: cleanQuery,
                actorAccountId: ws.installation.accountId,
                includeSchemas: false,
              });

              if (
                tool === null
                || (source !== undefined && tool.descriptor.sourceKey !== source)
                || (namespace !== undefined && tool.searchNamespace !== namespace)
              ) {
                return buildToolSearchResultSet(
                  payload,
                  {
                    mode: "exact",
                    searchMode: "fts",
                    results: [],
                  },
                );
              }

              return buildToolSearchResultSet(
                payload,
                {
                  mode: "exact",
                  searchMode: "fts",
                  results: [toolResultFromIndexEntry(tool, 1)],
                },
              );
            }

            const hits = yield* catalog.searchTools({
              query: cleanQuery,
              ...(namespace !== undefined ? { namespace } : {}),
              ...(source !== undefined ? { sourceKey: source } : {}),
              limit,
            });
            const searchMode = (
              hits as readonly SearchHit[] & { searchMode?: ToolSearchBackendMode }
            ).searchMode ?? "fts";

            const results: Array<ToolSearchResultSet["results"][number]> = [];
            for (const hit of hits) {
              const tool = yield* sourceCatalogStore.loadWorkspaceSourceCatalogToolByPath({
                workspaceId: ws.installation.workspaceId,
                path: hit.path,
                actorAccountId: ws.installation.accountId,
                includeSchemas: false,
              });
              if (tool === null) {
                continue;
              }

              results.push(toolResultFromIndexEntry(tool, hit.score));
              if (results.length >= limit) {
                break;
              }
            }

            return buildToolSearchResultSet(
              payload,
              {
                mode: "search",
                searchMode,
                results,
              },
            );
          }),
        ),
        mapError("SearchTools"),
      ),
  }),
);
