// ---------------------------------------------------------------------------
// @executor/react — REST-based React hooks for the executor API
// ---------------------------------------------------------------------------

// Provider
export { ExecutorReactProvider } from "./provider";

// All hooks
export {
  // Discovery & health
  useDiscover,
  useHealth,
  useLocalInstallation,
  // Config
  useInstanceConfig,
  useRefreshInstanceConfig,
  // Sources
  useSources,
  useSource,
  useSourceInspection,
  useSourceToolDetail,
  useSourceDiscovery,
  // Tool search
  useToolSearch,
  // Executions
  useExecutions,
  useExecution,
  useExecutionSteps,
  // Secrets
  useSecrets,
  useRefreshSecrets,
  // OAuth clients
  useWorkspaceOauthClients,
  // Prefetch (no-op compat)
  usePrefetchToolDetail,
  // Invalidation
  useInvalidateExecutorQueries,
  // Source mutations
  useCreateSource,
  useUpdateSource,
  useRemoveSource,
  useDiscoverSource,
  useConnectSource,
  useConnectSourceBatch,
  useStartSourceOAuth,
  // Execution mutations
  useCreateExecution,
  useResumeExecution,
  // Secret mutations
  useCreateSecret,
  useUpdateSecret,
  useDeleteSecret,
  // Config mutations
  useUpdateInstanceConfig,
  // OAuth client mutations
  useCreateWorkspaceOauthClient,
  useRemoveWorkspaceOauthClient,
  useRemoveProviderAuthGrant,
  // Errors
  FetchError,
} from "./hooks";

// Types
export type { Loadable, MutationResult } from "./types";

// Re-export executor-api types that views import from @executor/react
export type {
  Source,
  CreateSourceRequest,
  CreateSourceRequest as CreateSourcePayload,
  UpdateSourceRequest,
  UpdateSourceRequest as UpdateSourcePayload,
  SecretListItem,
  CreateSecretRequest,
  CreateSecretRequest as CreateSecretPayload,
  CreateSecretResponse,
  CreateSecretResponse as CreateSecretResult,
  UpdateSecretRequest,
  UpdateSecretRequest as UpdateSecretPayload,
  UpdateSecretResponse,
  UpdateSecretResponse as UpdateSecretResult,
  DeleteSecretResponse,
  DeleteSecretResponse as DeleteSecretResult,
  ToolSearchResultSet,
} from "@executor/api";

export type {
  ExecutionRecord,
  ExecutionRecord as Execution,
  ExecutionStep,
  ExecutionEnvelope,
  CreateExecutionRequest,
  ResumeExecutionRequest,
} from "@executor/api";

export type {
  ExecutorDescriptor,
  ExecutorTarget,
  HealthResponse,
} from "@executor/api";

// Legacy shim types (not yet in executor-api)
export type {
  InstanceConfig,
  LocalInstallation,
  SourceInspection,
  SourceInspectionToolDetail,
  SourceInspectionDiscoverResult,
  DiscoverSourcePayload,
  SourceDiscoveryResult,
  WorkspaceOauthClient,
  CreateWorkspaceOauthClientPayload,
  ConnectSourcePayload,
  ConnectSourceResult,
  ConnectSourceBatchPayload,
  ConnectSourceBatchResult,
  StartSourceOAuthPayload,
  StartSourceOAuthResult,
  CompleteSourceOAuthResult,
} from "./types";

// Backward compat: SourceRemoveResult
export type SourceRemoveResult = { removed: boolean };
