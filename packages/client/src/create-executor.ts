import type {
  Source,
  ToolSearchResultSet,
} from "@executor/api/sources";
import type {
  ExecutionRecord,
  ExecutionEnvelope,
  ExecutionStep,
} from "@executor/api/execution";
import type {
  SecretListItem,
  CreateSecretResponse,
  UpdateSecretResponse,
  DeleteSecretResponse,
} from "@executor/api/secrets";
import type { ExecutorDescriptor } from "@executor/api/types";
import type { Executor, CreateExecutorOptions } from "./types";

// ---------------------------------------------------------------------------
// Typed fetch helpers
// ---------------------------------------------------------------------------

class ExecutorApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, statusText: string, body: string) {
    super(`${status} ${statusText}: ${body}`);
    this.name = "ExecutorApiError";
    this.status = status;
    this.body = body;
  }
}

const createFetcher = (baseUrl: string) => {
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...init?.headers,
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ExecutorApiError(response.status, response.statusText, body);
    }
    return response.json() as Promise<T>;
  };

  return {
    get: <T>(path: string) => request<T>(path),
    post: <T>(path: string, body?: unknown) =>
      request<T>(path, {
        method: "POST",
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
    patch: <T>(path: string, body: unknown) =>
      request<T>(path, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  };
};

// ---------------------------------------------------------------------------
// createExecutor
// ---------------------------------------------------------------------------

export const createExecutor = async (
  options: CreateExecutorOptions,
): Promise<Executor> => {
  const { baseUrl } = options;
  const http = createFetcher(baseUrl);

  const installation = await http.get<{
    workspaceId: string;
    accountId: string;
  }>("/v1/local/installation");

  const ws = `/v1/workspaces/${installation.workspaceId}`;

  return {
    workspaceId: installation.workspaceId,
    accountId: installation.accountId,
    baseUrl,

    sources: {
      list: () => http.get<Source[]>(`${ws}/sources`),
      get: (id) => http.get<Source>(`${ws}/sources/${id}`),
      create: (payload) => http.post<Source>(`${ws}/sources`, payload),
      update: (id, payload) => http.patch<Source>(`${ws}/sources/${id}`, payload),
      remove: (id) => http.del<{ removed: boolean }>(`${ws}/sources/${id}`),
      discover: (payload) => http.post(`/v1/sources/discover`, payload),
    },

    executions: {
      list: () => http.get<ExecutionRecord[]>(`${ws}/executions`),
      get: (id) => http.get<ExecutionEnvelope>(`${ws}/executions/${id}`),
      create: (payload) => http.post<ExecutionEnvelope>(`${ws}/executions`, payload),
      resume: (id, payload) =>
        http.post<ExecutionEnvelope>(`${ws}/executions/${id}/resume`, payload),
      steps: (id) => http.get<ExecutionStep[]>(`${ws}/executions/${id}/steps`),
    },

    policies: {
      list: () => http.get(`${ws}/policies`),
      get: (id) => http.get(`${ws}/policies/${id}`),
      create: (payload) => http.post(`${ws}/policies`, payload),
      update: (id, payload) => http.patch(`${ws}/policies/${id}`, payload),
      remove: (id) => http.del(`${ws}/policies/${id}`),
    },

    secrets: {
      list: () => http.get<SecretListItem[]>(`/v1/local/secrets`),
      get: (id) => http.get<SecretListItem>(`/v1/local/secrets/${id}`),
      create: (payload) => http.post<CreateSecretResponse>(`/v1/local/secrets`, payload),
      update: (id, payload) =>
        http.patch<UpdateSecretResponse>(`/v1/local/secrets/${id}`, payload),
      remove: (id) => http.del<DeleteSecretResponse>(`/v1/local/secrets/${id}`),
    },

    catalog: {
      search: (query, opts) =>
        http.post<ToolSearchResultSet>(`${ws}/catalog/search`, { query, ...opts }),
    },

    local: {
      installation: () =>
        http.get<{ workspaceId: string; accountId: string }>("/v1/local/installation"),
      config: () => http.get(`/v1/local/config`),
      discover: () => http.get<ExecutorDescriptor>("/discover"),
    },

    close: () => {},
  };
};
