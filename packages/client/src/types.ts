import type {
  Source,
  CreateSourceRequest,
  UpdateSourceRequest,
  ToolSearchRequest,
  ToolSearchResultSet,
} from "@executor/api/sources";
import type {
  ExecutionRecord,
  ExecutionEnvelope,
  ExecutionStep,
  CreateExecutionRequest,
  ResumeExecutionRequest,
} from "@executor/api/execution";
import type {
  SecretListItem,
  CreateSecretRequest,
  CreateSecretResponse,
  UpdateSecretRequest,
  UpdateSecretResponse,
  DeleteSecretResponse,
} from "@executor/api/secrets";
import type { ExecutorDescriptor } from "@executor/api/types";

/**
 * Typed executor client. Uses FetchHttpClient internally,
 * exposes a Promise-based API with full type safety from @executor/api.
 */
export interface Executor {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly baseUrl: string;

  readonly sources: {
    list(): Promise<Source[]>;
    get(id: string): Promise<Source>;
    create(payload: CreateSourceRequest): Promise<Source>;
    update(id: string, payload: UpdateSourceRequest): Promise<Source>;
    remove(id: string): Promise<{ removed: boolean }>;
    discover(payload: unknown): Promise<unknown>;
  };

  readonly executions: {
    list(): Promise<ExecutionRecord[]>;
    get(id: string): Promise<ExecutionEnvelope>;
    create(payload: CreateExecutionRequest): Promise<ExecutionEnvelope>;
    resume(id: string, payload: ResumeExecutionRequest): Promise<ExecutionEnvelope>;
    steps(id: string): Promise<ExecutionStep[]>;
  };

  readonly policies: {
    list(): Promise<unknown[]>;
    get(id: string): Promise<unknown>;
    create(payload: unknown): Promise<unknown>;
    update(id: string, payload: unknown): Promise<unknown>;
    remove(id: string): Promise<unknown>;
  };

  readonly secrets: {
    list(): Promise<SecretListItem[]>;
    get(id: string): Promise<SecretListItem>;
    create(payload: CreateSecretRequest): Promise<CreateSecretResponse>;
    update(id: string, payload: UpdateSecretRequest): Promise<UpdateSecretResponse>;
    remove(id: string): Promise<DeleteSecretResponse>;
  };

  readonly catalog: {
    search(query: string, opts?: Omit<ToolSearchRequest, "query">): Promise<ToolSearchResultSet>;
  };

  readonly local: {
    installation(): Promise<{ workspaceId: string; accountId: string }>;
    config(): Promise<unknown>;
    discover(): Promise<ExecutorDescriptor>;
  };

  readonly close: () => void;
}

export interface CreateExecutorOptions {
  readonly baseUrl: string;
}
