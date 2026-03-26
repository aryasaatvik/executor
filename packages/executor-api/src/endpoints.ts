import type { ExecutorDescriptor, HealthResponse, ApiError } from "./types";
import type {
  ExecutionRecord,
  ExecutionEnvelope,
  ExecutionStep,
  CreateExecutionRequest,
  ResumeExecutionRequest,
} from "./execution";
import type {
  Source,
  CreateSourceRequest,
  UpdateSourceRequest,
  ToolSearchRequest,
  ToolSearchResultSet,
} from "./sources";
import type {
  SecretListItem,
  CreateSecretRequest,
  CreateSecretResponse,
  UpdateSecretRequest,
  UpdateSecretResponse,
  DeleteSecretResponse,
} from "./secrets";

// ---------------------------------------------------------------------------
// Endpoint definition helper
// ---------------------------------------------------------------------------

export interface Endpoint<
  TMethod extends string,
  TPath extends string,
  TRequest,
  TResponse,
> {
  readonly method: TMethod;
  readonly path: TPath;
  readonly request: TRequest;
  readonly response: TResponse;
  readonly error: ApiError;
}

// ---------------------------------------------------------------------------
// Discovery & health
// ---------------------------------------------------------------------------

export type Discover = Endpoint<"GET", "/discover", void, ExecutorDescriptor>;
export type Health = Endpoint<"GET", "/health", void, HealthResponse>;

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export type ListSources = Endpoint<"GET", "/v1/sources", void, Source[]>;
export type CreateSource = Endpoint<"POST", "/v1/sources", CreateSourceRequest, Source>;
export type GetSource = Endpoint<"GET", "/v1/sources/:id", void, Source>;
export type UpdateSource = Endpoint<"PATCH", "/v1/sources/:id", UpdateSourceRequest, Source>;
export type RemoveSource = Endpoint<"DELETE", "/v1/sources/:id", void, { removed: boolean }>;

// ---------------------------------------------------------------------------
// Tool search
// ---------------------------------------------------------------------------

export type SearchTools = Endpoint<"GET", "/v1/tools/search", ToolSearchRequest, ToolSearchResultSet>;

// ---------------------------------------------------------------------------
// Executions
// ---------------------------------------------------------------------------

export type ListExecutions = Endpoint<"GET", "/v1/executions", void, ExecutionRecord[]>;
export type CreateExecution = Endpoint<"POST", "/v1/executions", CreateExecutionRequest, ExecutionEnvelope>;
export type GetExecution = Endpoint<"GET", "/v1/executions/:id", void, ExecutionEnvelope>;
export type ResumeExecution = Endpoint<"POST", "/v1/executions/:id/resume", ResumeExecutionRequest, ExecutionEnvelope>;
export type ListExecutionSteps = Endpoint<"GET", "/v1/executions/:id/steps", void, ExecutionStep[]>;

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

export type ListSecrets = Endpoint<"GET", "/v1/secrets", void, SecretListItem[]>;
export type CreateSecret = Endpoint<"POST", "/v1/secrets", CreateSecretRequest, CreateSecretResponse>;
export type UpdateSecret = Endpoint<"PATCH", "/v1/secrets/:id", UpdateSecretRequest, UpdateSecretResponse>;
export type DeleteSecret = Endpoint<"DELETE", "/v1/secrets/:id", void, DeleteSecretResponse>;

// ---------------------------------------------------------------------------
// All endpoints union (for typed client generation)
// ---------------------------------------------------------------------------

export type ExecutorEndpoint =
  | Discover
  | Health
  | ListSources
  | CreateSource
  | GetSource
  | UpdateSource
  | RemoveSource
  | SearchTools
  | ListExecutions
  | CreateExecution
  | GetExecution
  | ResumeExecution
  | ListExecutionSteps
  | ListSecrets
  | CreateSecret
  | UpdateSecret
  | DeleteSecret;
