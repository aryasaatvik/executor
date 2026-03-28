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

function useWorkspacePath(
  buildPath: (installation: LocalInstallation) => string | null,
): string | null {
  const installation = useLocalInstallation();
  return React.useMemo(() => {
    if (installation.status !== "ready") {
      return null;
    }
    return buildPath(installation.data);
  }, [buildPath, installation]);
}

function useWorkspaceQuery<T>(
  buildPath: (installation: LocalInstallation) => string | null,
): Loadable<T> {
  const installation = useLocalInstallation();
  const path = useWorkspacePath(buildPath);
  const result = useConditionalQuery<T>(path);

  return React.useMemo<Loadable<T>>(() => {
    if (installation.status === "loading") return { status: "loading" };
    if (installation.status === "error") return installation;
    return result;
  }, [installation, result]);
}

function requireLocalInstallation(
  installation: Loadable<LocalInstallation>,
): LocalInstallation {
  if (installation.status !== "ready") {
    throw new Error("Local installation is not ready");
  }
  return installation.data;
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
// Installation
// ---------------------------------------------------------------------------

export function useLocalInstallation(): Loadable<LocalInstallation> {
  return useQuery<LocalInstallation>("/v1/local/installation");
}

// ---------------------------------------------------------------------------
// Instance config
// ---------------------------------------------------------------------------

export function useInstanceConfig(): Loadable<InstanceConfig> {
  return useQuery<InstanceConfig>("/v1/local/config");
}

export function useRefreshInstanceConfig(): () => void {
  const { invalidateQueries } = useExecutorContext();
  return invalidateQueries;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export function useSources(): Loadable<readonly Source[]> {
  return useWorkspaceQuery<Source[]>(
    (installation) => `/v1/workspaces/${encodeURIComponent(installation.workspaceId)}/sources`,
  );
}

export function useSource(sourceId: string): Loadable<Source> {
  return useWorkspaceQuery<Source>((installation) =>
    `/v1/workspaces/${encodeURIComponent(installation.workspaceId)}/sources/${encodeURIComponent(sourceId)}`,
  );
}

export function useSourceInspection(sourceId: string): Loadable<SourceInspection> {
  return useWorkspaceQuery<SourceInspection>((installation) =>
    `/v1/workspaces/${encodeURIComponent(installation.workspaceId)}/sources/${encodeURIComponent(sourceId)}/inspection`,
  );
}

export function useSourceToolDetail(
  sourceId: string,
  toolPath: string | null,
): Loadable<SourceInspectionToolDetail | null> {
  return useWorkspaceQuery<SourceInspectionToolDetail | null>((installation) =>
    toolPath !== null
      ? `/v1/workspaces/${encodeURIComponent(installation.workspaceId)}/sources/${encodeURIComponent(sourceId)}/tools/${encodeURIComponent(toolPath)}/inspection`
      : null,
  );
}

export function useSourceDiscovery(input: {
  sourceId: string;
  query: string;
  limit?: number;
}): Loadable<SourceInspectionDiscoverResult> {
  const { baseUrl, invalidationVersion } = useExecutorContext();
  const installation = useLocalInstallation();
  const emptyResult = React.useMemo<SourceInspectionDiscoverResult>(
    () => ({ query: "", queryTokens: [], bestPath: null, total: 0, results: [] }),
    [],
  );
  const trimmed = input.query.trim();
  const [state, setState] = React.useState<Loadable<SourceInspectionDiscoverResult>>({
    status: "ready",
    data: emptyResult,
  });

  React.useEffect(() => {
    if (installation.status === "loading") {
      setState({ status: "loading" });
      return;
    }

    if (installation.status === "error") {
      setState(installation);
      return;
    }

    if (trimmed.length === 0) {
      setState({ status: "ready", data: emptyResult });
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });

    fetchJson<SourceInspectionDiscoverResult>(
      `${baseUrl}/v1/workspaces/${encodeURIComponent(installation.data.workspaceId)}/sources/${encodeURIComponent(input.sourceId)}/inspection/discover`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: trimmed,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        }),
      },
    )
      .then((data) => {
        if (!cancelled) {
          setState({ status: "ready", data });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setState({
            status: "error",
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    baseUrl,
    emptyResult,
    input.limit,
    input.sourceId,
    installation,
    invalidationVersion,
    trimmed,
  ]);

  return state;
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
  return useWorkspaceQuery<ExecutionRecord[]>(
    (installation) => `/v1/workspaces/${encodeURIComponent(installation.workspaceId)}/executions`,
  );
}

export function useExecution(executionId: string): Loadable<ExecutionEnvelope> {
  return useWorkspaceQuery<ExecutionEnvelope>((installation) =>
    `/v1/workspaces/${encodeURIComponent(installation.workspaceId)}/executions/${encodeURIComponent(executionId)}`,
  );
}

export function useExecutionSteps(
  executionId: string,
): Loadable<readonly ExecutionStep[]> {
  const installation = useLocalInstallation();
  const path = useWorkspacePath((loadedInstallation) =>
    executionId.length > 0
      ? `/v1/workspaces/${encodeURIComponent(loadedInstallation.workspaceId)}/executions/${encodeURIComponent(executionId)}/steps`
      : null,
  );
  const result = useConditionalQuery<ExecutionStep[]>(path);

  return React.useMemo<Loadable<readonly ExecutionStep[]>>(() => {
    if (installation.status === "loading") return { status: "loading" };
    if (installation.status === "error") return installation;
    if (path === null) return { status: "ready", data: [] };
    return result;
  }, [installation, path, result]);
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

export function useSecrets(): Loadable<readonly SecretListItem[]> {
  return useQuery<SecretListItem[]>("/v1/local/secrets");
}

export function useRefreshSecrets(): () => void {
  const { invalidateQueries } = useExecutorContext();
  return invalidateQueries;
}

// ---------------------------------------------------------------------------
// Workspace OAuth clients
// ---------------------------------------------------------------------------

export function useWorkspaceOauthClients(
  providerKey: string | null,
): Loadable<readonly WorkspaceOauthClient[]> {
  const installation = useLocalInstallation();
  const path = useWorkspacePath((loadedInstallation) =>
    providerKey !== null
      ? `/v1/workspaces/${encodeURIComponent(loadedInstallation.workspaceId)}/oauth-clients?providerKey=${encodeURIComponent(providerKey)}`
      : null,
  );
  const result = useConditionalQuery<WorkspaceOauthClient[]>(path);

  return React.useMemo<Loadable<readonly WorkspaceOauthClient[]>>(() => {
    if (installation.status === "loading") return { status: "loading" };
    if (installation.status === "error") return installation;
    if (path === null) return { status: "ready", data: [] };
    return result;
  }, [installation, path, result]);
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
  const installation = useLocalInstallation();
  const execute = React.useCallback(
    (payload: CreateSourceRequest) =>
      fetchJson<Source>(`${baseUrl}/v1/workspaces/${encodeURIComponent(requireLocalInstallation(installation).workspaceId)}/sources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    [baseUrl, installation],
  );
  return useMutation(execute, React.useMemo(() => ({ onSuccess: invalidateQueries }), [invalidateQueries]));
}

export function useUpdateSource(): MutationResult<
  { sourceId: string; payload: UpdateSourceRequest },
  Source
> {
  const { baseUrl, invalidateQueries } = useExecutorContext();
  const installation = useLocalInstallation();
  const execute = React.useCallback(
    (input: { sourceId: string; payload: UpdateSourceRequest }) =>
      fetchJson<Source>(
        `${baseUrl}/v1/workspaces/${encodeURIComponent(requireLocalInstallation(installation).workspaceId)}/sources/${encodeURIComponent(input.sourceId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input.payload),
        },
      ),
    [baseUrl, installation],
  );
  return useMutation(execute, React.useMemo(() => ({ onSuccess: invalidateQueries }), [invalidateQueries]));
}

export function useRemoveSource(): MutationResult<string, { removed: boolean }> {
  const { baseUrl, invalidateQueries } = useExecutorContext();
  const installation = useLocalInstallation();
  const execute = React.useCallback(
    (sourceId: string) =>
      fetchJson<{ removed: boolean }>(
        `${baseUrl}/v1/workspaces/${encodeURIComponent(requireLocalInstallation(installation).workspaceId)}/sources/${encodeURIComponent(sourceId)}`,
        { method: "DELETE" },
      ),
    [baseUrl, installation],
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
  const installation = useLocalInstallation();
  const execute = React.useCallback(
    (payload: ConnectSourcePayload) =>
      fetchJson<ConnectSourceResult>(
        `${baseUrl}/v1/workspaces/${encodeURIComponent(requireLocalInstallation(installation).workspaceId)}/sources/connect`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
      ),
    [baseUrl, installation],
  );
  return useMutation(execute, React.useMemo(() => ({ onSuccess: invalidateQueries }), [invalidateQueries]));
}

export function useConnectSourceBatch(): MutationResult<ConnectSourceBatchPayload, ConnectSourceBatchResult> {
  const { baseUrl, invalidateQueries } = useExecutorContext();
  const installation = useLocalInstallation();
  const execute = React.useCallback(
    (payload: ConnectSourceBatchPayload) =>
      fetchJson<ConnectSourceBatchResult>(`${baseUrl}/v1/workspaces/${encodeURIComponent(requireLocalInstallation(installation).workspaceId)}/sources/connect-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    [baseUrl, installation],
  );
  return useMutation(execute, React.useMemo(() => ({ onSuccess: invalidateQueries }), [invalidateQueries]));
}

export function useStartSourceOAuth(): MutationResult<StartSourceOAuthPayload, StartSourceOAuthResult> {
  const { baseUrl } = useExecutorContext();
  const installation = useLocalInstallation();
  const execute = React.useCallback(
    (payload: StartSourceOAuthPayload) =>
      fetchJson<StartSourceOAuthResult>(`${baseUrl}/v1/workspaces/${encodeURIComponent(requireLocalInstallation(installation).workspaceId)}/oauth/source-auth/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    [baseUrl, installation],
  );
  return useMutation(execute);
}

// ---------------------------------------------------------------------------
// Execution mutations
// ---------------------------------------------------------------------------

export function useCreateExecution(): MutationResult<CreateExecutionRequest, ExecutionEnvelope> {
  const { baseUrl, invalidateQueries } = useExecutorContext();
  const installation = useLocalInstallation();
  const execute = React.useCallback(
    (payload: CreateExecutionRequest) =>
      fetchJson<ExecutionEnvelope>(`${baseUrl}/v1/workspaces/${encodeURIComponent(requireLocalInstallation(installation).workspaceId)}/executions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    [baseUrl, installation],
  );
  return useMutation(execute, React.useMemo(() => ({ onSuccess: invalidateQueries }), [invalidateQueries]));
}

export function useResumeExecution(): MutationResult<
  { executionId: string; payload: ResumeExecutionRequest },
  ExecutionEnvelope
> {
  const { baseUrl, invalidateQueries } = useExecutorContext();
  const installation = useLocalInstallation();
  const execute = React.useCallback(
    (input: { executionId: string; payload: ResumeExecutionRequest }) =>
      fetchJson<ExecutionEnvelope>(
        `${baseUrl}/v1/workspaces/${encodeURIComponent(requireLocalInstallation(installation).workspaceId)}/executions/${encodeURIComponent(input.executionId)}/resume`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input.payload),
        },
      ),
    [baseUrl, installation],
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
      fetchJson<CreateSecretResponse>(`${baseUrl}/v1/local/secrets`, {
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
        `${baseUrl}/v1/local/secrets/${encodeURIComponent(input.secretId)}`,
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
        `${baseUrl}/v1/local/secrets/${encodeURIComponent(secretId)}`,
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
      fetchJson<InstanceConfig>(`${baseUrl}/v1/local/config`, {
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
  const installation = useLocalInstallation();
  const execute = React.useCallback(
    (payload: CreateWorkspaceOauthClientPayload) =>
      fetchJson<WorkspaceOauthClient>(`${baseUrl}/v1/workspaces/${encodeURIComponent(requireLocalInstallation(installation).workspaceId)}/oauth-clients`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    [baseUrl, installation],
  );
  return useMutation(execute, React.useMemo(() => ({ onSuccess: invalidateQueries }), [invalidateQueries]));
}

export function useRemoveWorkspaceOauthClient(): MutationResult<string, { removed: boolean }> {
  const { baseUrl, invalidateQueries } = useExecutorContext();
  const installation = useLocalInstallation();
  const execute = React.useCallback(
    (clientId: string) =>
      fetchJson<{ removed: boolean }>(
        `${baseUrl}/v1/workspaces/${encodeURIComponent(requireLocalInstallation(installation).workspaceId)}/oauth-clients/${encodeURIComponent(clientId)}`,
        { method: "DELETE" },
      ),
    [baseUrl, installation],
  );
  return useMutation(execute, React.useMemo(() => ({ onSuccess: invalidateQueries }), [invalidateQueries]));
}

export function useRemoveProviderAuthGrant(): MutationResult<string, { removed: boolean }> {
  const { baseUrl, invalidateQueries } = useExecutorContext();
  const installation = useLocalInstallation();
  const execute = React.useCallback(
    (grantId: string) =>
      fetchJson<{ removed: boolean }>(
        `${baseUrl}/v1/workspaces/${encodeURIComponent(requireLocalInstallation(installation).workspaceId)}/provider-grants/${encodeURIComponent(grantId)}`,
        { method: "DELETE" },
      ),
    [baseUrl, installation],
  );
  return useMutation(execute, React.useMemo(() => ({ onSuccess: invalidateQueries }), [invalidateQueries]));
}

export { FetchError };
