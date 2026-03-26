import * as React from "react";
import type {
  Source,
  CreateSourceRequest,
  UpdateSourceRequest,
  SecretListItem,
  CreateSecretRequest,
  CreateSecretResponse,
  UpdateSecretRequest,
  UpdateSecretResponse,
  DeleteSecretResponse,
  ExecutionRecord,
  ExecutionStep,
  ExecutionEnvelope,
  CreateExecutionRequest,
  ResumeExecutionRequest,
  ExecutorDescriptor,
  HealthResponse,
  ToolSearchResultSet,
} from "@executor/api";
import { useExecutorContext } from "./provider";
import { useFetch, fetchJson, FetchError } from "./use-fetch";
import { useMutation } from "./use-mutation";
import type {
  Loadable,
  MutationResult,
  InstanceConfig,
  LocalInstallation,
  SourceInspection,
  SourceInspectionToolDetail,
  SourceInspectionDiscoverResult,
  DiscoverSourcePayload,
  SourceDiscoveryResult,
  ConnectSourcePayload,
  ConnectSourceResult,
  ConnectSourceBatchPayload,
  ConnectSourceBatchResult,
  StartSourceOAuthPayload,
  StartSourceOAuthResult,
  WorkspaceOauthClient,
  CreateWorkspaceOauthClientPayload,
} from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function useUrl(path: string): string {
  const { baseUrl } = useExecutorContext();
  return `${baseUrl}${path}`;
}

function useQuery<T>(path: string): Loadable<T> {
  const url = useUrl(path);
  const { invalidationVersion } = useExecutorContext();
  return useFetch<T>(url, invalidationVersion);
}

function useConditionalQuery<T>(path: string | null): Loadable<T> {
  const { baseUrl, invalidationVersion } = useExecutorContext();
  const url = path !== null ? `${baseUrl}${path}` : null;
  return useFetch<T>(url, invalidationVersion);
}

// ---------------------------------------------------------------------------
// Discovery & health
// ---------------------------------------------------------------------------

export function useDiscover(): Loadable<ExecutorDescriptor> {
  return useQuery<ExecutorDescriptor>("/discover");
}

export function useHealth(): Loadable<HealthResponse> {
  return useQuery<HealthResponse>("/health");
}

// ---------------------------------------------------------------------------
// Installation (shim — calls /discover and maps to LocalInstallation shape)
// ---------------------------------------------------------------------------

export function useLocalInstallation(): Loadable<LocalInstallation> {
  const discover = useDiscover();
  return React.useMemo<Loadable<LocalInstallation>>(() => {
    if (discover.status !== "ready") return discover;
    return {
      status: "ready",
      data: {
        workspaceId: discover.data.id,
        accountId: discover.data.id,
      },
    };
  }, [discover]);
}

// ---------------------------------------------------------------------------
// Instance config
// ---------------------------------------------------------------------------

export function useInstanceConfig(): Loadable<InstanceConfig> {
  return useQuery<InstanceConfig>("/v1/config");
}

export function useRefreshInstanceConfig(): () => void {
  const { invalidateQueries } = useExecutorContext();
  return invalidateQueries;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export function useSources(): Loadable<readonly Source[]> {
  return useQuery<Source[]>("/v1/sources");
}

export function useSource(sourceId: string): Loadable<Source> {
  return useQuery<Source>(`/v1/sources/${encodeURIComponent(sourceId)}`);
}

export function useSourceInspection(sourceId: string): Loadable<SourceInspection> {
  return useQuery<SourceInspection>(
    `/v1/sources/${encodeURIComponent(sourceId)}/inspection`,
  );
}

export function useSourceToolDetail(
  sourceId: string,
  toolPath: string | null,
): Loadable<SourceInspectionToolDetail | null> {
  const path =
    toolPath !== null
      ? `/v1/sources/${encodeURIComponent(sourceId)}/tools/${encodeURIComponent(toolPath)}`
      : null;
  return useConditionalQuery<SourceInspectionToolDetail | null>(path);
}

export function useSourceDiscovery(input: {
  sourceId: string;
  query: string;
  limit?: number;
}): Loadable<SourceInspectionDiscoverResult> {
  const emptyResult: SourceInspectionDiscoverResult = React.useMemo(
    () => ({ query: "", queryTokens: [], bestPath: null, total: 0, results: [] }),
    [],
  );

  const trimmed = input.query.trim();
  const params = new URLSearchParams({ query: trimmed });
  if (input.limit !== undefined) params.set("limit", String(input.limit));

  const path =
    trimmed.length > 0
      ? `/v1/sources/${encodeURIComponent(input.sourceId)}/discover?${params}`
      : null;

  const result = useConditionalQuery<SourceInspectionDiscoverResult>(path);

  return React.useMemo<Loadable<SourceInspectionDiscoverResult>>(() => {
    if (path === null) return { status: "ready", data: emptyResult };
    return result;
  }, [path, result, emptyResult]);
}

// ---------------------------------------------------------------------------
// Tool search
// ---------------------------------------------------------------------------

export function useToolSearch(query: string): Loadable<ToolSearchResultSet> {
  const trimmed = query.trim();
  const params = new URLSearchParams({ query: trimmed });
  const path = trimmed.length > 0 ? `/v1/tools/search?${params}` : null;
  return useConditionalQuery<ToolSearchResultSet>(path);
}

// ---------------------------------------------------------------------------
// Executions
// ---------------------------------------------------------------------------

export function useExecutions(): Loadable<readonly ExecutionRecord[]> {
  return useQuery<ExecutionRecord[]>("/v1/executions");
}

export function useExecution(executionId: string): Loadable<ExecutionEnvelope> {
  return useQuery<ExecutionEnvelope>(
    `/v1/executions/${encodeURIComponent(executionId)}`,
  );
}

export function useExecutionSteps(
  executionId: string,
): Loadable<readonly ExecutionStep[]> {
  const path =
    executionId.length > 0
      ? `/v1/executions/${encodeURIComponent(executionId)}/steps`
      : null;

  const result = useConditionalQuery<ExecutionStep[]>(path);

  return React.useMemo<Loadable<readonly ExecutionStep[]>>(() => {
    if (path === null) return { status: "ready", data: [] };
    return result;
  }, [path, result]);
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

export function useSecrets(): Loadable<readonly SecretListItem[]> {
  return useQuery<SecretListItem[]>("/v1/secrets");
}

export function useRefreshSecrets(): () => void {
  const { invalidateQueries } = useExecutorContext();
  return invalidateQueries;
}

// ---------------------------------------------------------------------------
// Workspace OAuth clients (legacy shim endpoint)
// ---------------------------------------------------------------------------

export function useWorkspaceOauthClients(
  providerKey: string | null,
): Loadable<readonly WorkspaceOauthClient[]> {
  const params = providerKey !== null ? `?providerKey=${encodeURIComponent(providerKey)}` : "";
  const path = providerKey !== null ? `/v1/oauth/clients${params}` : null;

  const result = useConditionalQuery<WorkspaceOauthClient[]>(path);

  return React.useMemo<Loadable<readonly WorkspaceOauthClient[]>>(() => {
    if (path === null) return { status: "ready", data: [] };
    return result;
  }, [path, result]);
}

// ---------------------------------------------------------------------------
// Prefetch (no-op in REST mode — kept for API compatibility)
// ---------------------------------------------------------------------------

export function usePrefetchToolDetail(): (
  sourceId: string,
  toolPath: string,
) => () => void {
  return React.useCallback(() => () => {}, []);
}

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

export function useInvalidateExecutorQueries(): () => void {
  const { invalidateQueries } = useExecutorContext();
  return invalidateQueries;
}

// ---------------------------------------------------------------------------
// Source mutations
// ---------------------------------------------------------------------------

export function useCreateSource(): MutationResult<CreateSourceRequest, Source> {
  const { baseUrl, invalidateQueries } = useExecutorContext();
  const execute = React.useCallback(
    (payload: CreateSourceRequest) =>
      fetchJson<Source>(`${baseUrl}/v1/sources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    [baseUrl],
  );
  return useMutation(execute, React.useMemo(() => ({ onSuccess: invalidateQueries }), [invalidateQueries]));
}

export function useUpdateSource(): MutationResult<
  { sourceId: string; payload: UpdateSourceRequest },
  Source
> {
  const { baseUrl, invalidateQueries } = useExecutorContext();
  const execute = React.useCallback(
    (input: { sourceId: string; payload: UpdateSourceRequest }) =>
      fetchJson<Source>(
        `${baseUrl}/v1/sources/${encodeURIComponent(input.sourceId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input.payload),
        },
      ),
    [baseUrl],
  );
  return useMutation(execute, React.useMemo(() => ({ onSuccess: invalidateQueries }), [invalidateQueries]));
}

export function useRemoveSource(): MutationResult<string, { removed: boolean }> {
  const { baseUrl, invalidateQueries } = useExecutorContext();
  const execute = React.useCallback(
    (sourceId: string) =>
      fetchJson<{ removed: boolean }>(
        `${baseUrl}/v1/sources/${encodeURIComponent(sourceId)}`,
        { method: "DELETE" },
      ),
    [baseUrl],
  );
  return useMutation(execute, React.useMemo(() => ({ onSuccess: invalidateQueries }), [invalidateQueries]));
}

export function useDiscoverSource(): MutationResult<DiscoverSourcePayload, SourceDiscoveryResult> {
  const { baseUrl } = useExecutorContext();
  const execute = React.useCallback(
    (payload: DiscoverSourcePayload) =>
      fetchJson<SourceDiscoveryResult>(`${baseUrl}/v1/sources/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    [baseUrl],
  );
  return useMutation(execute);
}

export function useConnectSource(): MutationResult<ConnectSourcePayload, ConnectSourceResult> {
  const { baseUrl, invalidateQueries } = useExecutorContext();
  const execute = React.useCallback(
    (payload: ConnectSourcePayload) =>
      fetchJson<ConnectSourceResult>(
        `${baseUrl}/v1/sources/${encodeURIComponent(payload.sourceId)}/connect`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
      ),
    [baseUrl],
  );
  return useMutation(execute, React.useMemo(() => ({ onSuccess: invalidateQueries }), [invalidateQueries]));
}

export function useConnectSourceBatch(): MutationResult<ConnectSourceBatchPayload, ConnectSourceBatchResult> {
  const { baseUrl, invalidateQueries } = useExecutorContext();
  const execute = React.useCallback(
    (payload: ConnectSourceBatchPayload) =>
      fetchJson<ConnectSourceBatchResult>(`${baseUrl}/v1/sources/connect-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    [baseUrl],
  );
  return useMutation(execute, React.useMemo(() => ({ onSuccess: invalidateQueries }), [invalidateQueries]));
}

export function useStartSourceOAuth(): MutationResult<StartSourceOAuthPayload, StartSourceOAuthResult> {
  const { baseUrl } = useExecutorContext();
  const execute = React.useCallback(
    (payload: StartSourceOAuthPayload) =>
      fetchJson<StartSourceOAuthResult>(`${baseUrl}/v1/oauth/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    [baseUrl],
  );
  return useMutation(execute);
}

// ---------------------------------------------------------------------------
// Execution mutations
// ---------------------------------------------------------------------------

export function useCreateExecution(): MutationResult<CreateExecutionRequest, ExecutionEnvelope> {
  const { baseUrl, invalidateQueries } = useExecutorContext();
  const execute = React.useCallback(
    (payload: CreateExecutionRequest) =>
      fetchJson<ExecutionEnvelope>(`${baseUrl}/v1/executions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    [baseUrl],
  );
  return useMutation(execute, React.useMemo(() => ({ onSuccess: invalidateQueries }), [invalidateQueries]));
}

export function useResumeExecution(): MutationResult<
  { executionId: string; payload: ResumeExecutionRequest },
  ExecutionEnvelope
> {
  const { baseUrl, invalidateQueries } = useExecutorContext();
  const execute = React.useCallback(
    (input: { executionId: string; payload: ResumeExecutionRequest }) =>
      fetchJson<ExecutionEnvelope>(
        `${baseUrl}/v1/executions/${encodeURIComponent(input.executionId)}/resume`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input.payload),
        },
      ),
    [baseUrl],
  );
  return useMutation(execute, React.useMemo(() => ({ onSuccess: invalidateQueries }), [invalidateQueries]));
}

// ---------------------------------------------------------------------------
// Secret mutations
// ---------------------------------------------------------------------------

export function useCreateSecret(): MutationResult<CreateSecretRequest, CreateSecretResponse> {
  const { baseUrl, invalidateQueries } = useExecutorContext();
  const execute = React.useCallback(
    (payload: CreateSecretRequest) =>
      fetchJson<CreateSecretResponse>(`${baseUrl}/v1/secrets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    [baseUrl],
  );
  return useMutation(execute, React.useMemo(() => ({ onSuccess: invalidateQueries }), [invalidateQueries]));
}

export function useUpdateSecret(): MutationResult<
  { secretId: string; payload: UpdateSecretRequest },
  UpdateSecretResponse
> {
  const { baseUrl, invalidateQueries } = useExecutorContext();
  const execute = React.useCallback(
    (input: { secretId: string; payload: UpdateSecretRequest }) =>
      fetchJson<UpdateSecretResponse>(
        `${baseUrl}/v1/secrets/${encodeURIComponent(input.secretId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input.payload),
        },
      ),
    [baseUrl],
  );
  return useMutation(execute, React.useMemo(() => ({ onSuccess: invalidateQueries }), [invalidateQueries]));
}

export function useDeleteSecret(): MutationResult<string, DeleteSecretResponse> {
  const { baseUrl, invalidateQueries } = useExecutorContext();
  const execute = React.useCallback(
    (secretId: string) =>
      fetchJson<DeleteSecretResponse>(
        `${baseUrl}/v1/secrets/${encodeURIComponent(secretId)}`,
        { method: "DELETE" },
      ),
    [baseUrl],
  );
  return useMutation(execute, React.useMemo(() => ({ onSuccess: invalidateQueries }), [invalidateQueries]));
}

// ---------------------------------------------------------------------------
// Config mutations
// ---------------------------------------------------------------------------

export function useUpdateInstanceConfig(): MutationResult<
  { semanticSearch: InstanceConfig["semanticSearch"] },
  InstanceConfig
> {
  const { baseUrl, invalidateQueries } = useExecutorContext();
  const execute = React.useCallback(
    (payload: { semanticSearch: InstanceConfig["semanticSearch"] }) =>
      fetchJson<InstanceConfig>(`${baseUrl}/v1/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    [baseUrl],
  );
  return useMutation(execute, React.useMemo(() => ({ onSuccess: invalidateQueries }), [invalidateQueries]));
}

// ---------------------------------------------------------------------------
// Workspace OAuth client mutations
// ---------------------------------------------------------------------------

export function useCreateWorkspaceOauthClient(): MutationResult<
  CreateWorkspaceOauthClientPayload,
  WorkspaceOauthClient
> {
  const { baseUrl, invalidateQueries } = useExecutorContext();
  const execute = React.useCallback(
    (payload: CreateWorkspaceOauthClientPayload) =>
      fetchJson<WorkspaceOauthClient>(`${baseUrl}/v1/oauth/clients`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    [baseUrl],
  );
  return useMutation(execute, React.useMemo(() => ({ onSuccess: invalidateQueries }), [invalidateQueries]));
}

export function useRemoveWorkspaceOauthClient(): MutationResult<string, { removed: boolean }> {
  const { baseUrl, invalidateQueries } = useExecutorContext();
  const execute = React.useCallback(
    (clientId: string) =>
      fetchJson<{ removed: boolean }>(
        `${baseUrl}/v1/oauth/clients/${encodeURIComponent(clientId)}`,
        { method: "DELETE" },
      ),
    [baseUrl],
  );
  return useMutation(execute, React.useMemo(() => ({ onSuccess: invalidateQueries }), [invalidateQueries]));
}

export function useRemoveProviderAuthGrant(): MutationResult<string, { removed: boolean }> {
  const { baseUrl, invalidateQueries } = useExecutorContext();
  const execute = React.useCallback(
    (grantId: string) =>
      fetchJson<{ removed: boolean }>(
        `${baseUrl}/v1/oauth/grants/${encodeURIComponent(grantId)}`,
        { method: "DELETE" },
      ),
    [baseUrl],
  );
  return useMutation(execute, React.useMemo(() => ({ onSuccess: invalidateQueries }), [invalidateQueries]));
}

export { FetchError };
