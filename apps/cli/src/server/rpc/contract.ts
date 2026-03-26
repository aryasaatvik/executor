import * as Rpc from "@effect/rpc/Rpc";
import * as RpcGroup from "@effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

import {
  ExecutionEnvelopeSchema,
  ExecutionIdSchema,
  ExecutionSessionIdSchema,
  ExecutionStepSchema,
  PolicyIdSchema,
  SourceIdSchema,
  SourceSchema,
  ToolSearchPayloadSchema,
  ToolSearchResultSetSchema,
} from "@executor/control-plane/model";
import {
  ExecutionSchema,
  LocalInstallationSchema,
  LocalWorkspacePolicySchema,
  SourceDiscoveryResultSchema,
  SourceInspectionSchema,
  SourceInspectionToolDetailSchema,
  SourceInspectionDiscoverPayloadSchema,
  SourceInspectionDiscoverResultSchema,
} from "@executor/engine/schema";

import {
  CreateExecutionPayloadSchema,
  ResumeExecutionPayloadSchema,
} from "../api/executions/api";

import {
  CreateSourcePayloadSchema,
  UpdateSourcePayloadSchema,
  DiscoverSourcePayloadSchema,
  ConnectSourcePayloadSchema,
  ConnectSourceResultSchema,
  ConnectSourceBatchPayloadSchema,
  ConnectSourceBatchResultSchema,
} from "../api/sources/api";

import {
  CreatePolicyPayloadSchema,
  UpdatePolicyPayloadSchema,
} from "../api/policies/api";

import {
  SecretListItemSchema,
  CreateSecretPayloadSchema,
  CreateSecretResultSchema,
  UpdateSecretPayloadSchema,
  UpdateSecretResultSchema,
  DeleteSecretResultSchema,
  InstanceConfigSchema,
  UpdateInstanceConfigPayloadSchema,
} from "../api/local/api";

import {
  StartSourceOAuthPayloadSchema,
  StartSourceOAuthResultSchema,
} from "../api/oauth/api";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class ExecutorRpcError extends Schema.TaggedError<ExecutorRpcError>()(
  "ExecutorRpcError",
  {
    operation: Schema.String,
    message: Schema.String,
    code: Schema.Literal("bad_request", "unauthorized", "forbidden", "not_found", "storage"),
  },
) {}

// ---------------------------------------------------------------------------
// Combined group
// ---------------------------------------------------------------------------

export const ExecutorRpcs = RpcGroup.make(
  // Sources
  Rpc.make("ListSources", {
    success: Schema.Array(SourceSchema),
    error: ExecutorRpcError,
  }),
  Rpc.make("GetSource", {
    payload: Schema.Struct({ sourceId: SourceIdSchema }),
    success: SourceSchema,
    error: ExecutorRpcError,
  }),
  Rpc.make("CreateSource", {
    payload: CreateSourcePayloadSchema,
    success: SourceSchema,
    error: ExecutorRpcError,
  }),
  Rpc.make("UpdateSource", {
    payload: Schema.Struct({
      sourceId: SourceIdSchema,
      update: UpdateSourcePayloadSchema,
    }),
    success: SourceSchema,
    error: ExecutorRpcError,
  }),
  Rpc.make("RemoveSource", {
    payload: Schema.Struct({ sourceId: SourceIdSchema }),
    success: Schema.Struct({ removed: Schema.Boolean }),
    error: ExecutorRpcError,
  }),
  Rpc.make("DiscoverSource", {
    payload: DiscoverSourcePayloadSchema,
    success: SourceDiscoveryResultSchema,
    error: ExecutorRpcError,
  }),
  Rpc.make("ConnectSource", {
    payload: ConnectSourcePayloadSchema,
    success: ConnectSourceResultSchema,
    error: ExecutorRpcError,
  }),
  Rpc.make("ConnectSourceBatch", {
    payload: ConnectSourceBatchPayloadSchema,
    success: ConnectSourceBatchResultSchema,
    error: ExecutorRpcError,
  }),

  // Source inspection
  Rpc.make("GetSourceInspection", {
    payload: Schema.Struct({ sourceId: SourceIdSchema }),
    success: SourceInspectionSchema,
    error: ExecutorRpcError,
  }),
  Rpc.make("GetSourceInspectionToolDetail", {
    payload: Schema.Struct({ sourceId: SourceIdSchema, toolPath: Schema.String }),
    success: SourceInspectionToolDetailSchema,
    error: ExecutorRpcError,
  }),
  Rpc.make("DiscoverSourceInspectionTools", {
    payload: Schema.Struct({
      sourceId: SourceIdSchema,
      discover: SourceInspectionDiscoverPayloadSchema,
    }),
    success: SourceInspectionDiscoverResultSchema,
    error: ExecutorRpcError,
  }),

  // Executions
  Rpc.make("ListExecutions", {
    success: Schema.Array(ExecutionSchema),
    error: ExecutorRpcError,
  }),
  Rpc.make("CreateExecution", {
    payload: CreateExecutionPayloadSchema,
    success: ExecutionEnvelopeSchema,
    error: ExecutorRpcError,
  }),
  Rpc.make("GetExecution", {
    payload: Schema.Struct({ executionId: ExecutionIdSchema }),
    success: ExecutionEnvelopeSchema,
    error: ExecutorRpcError,
  }),
  Rpc.make("ResumeExecution", {
    payload: Schema.Struct({
      executionId: ExecutionIdSchema,
      resume: ResumeExecutionPayloadSchema,
    }),
    success: ExecutionEnvelopeSchema,
    error: ExecutorRpcError,
  }),
  Rpc.make("ListExecutionSteps", {
    payload: Schema.Struct({ executionId: ExecutionIdSchema }),
    success: Schema.Array(ExecutionStepSchema),
    error: ExecutorRpcError,
  }),
  Rpc.make("CloseExecutionSession", {
    payload: Schema.Struct({ executionSessionId: ExecutionSessionIdSchema }),
    success: Schema.Struct({ closed: Schema.Boolean }),
    error: ExecutorRpcError,
  }),

  // Secrets
  Rpc.make("ListSecrets", {
    success: Schema.Array(SecretListItemSchema),
    error: ExecutorRpcError,
  }),
  Rpc.make("CreateSecret", {
    payload: CreateSecretPayloadSchema,
    success: CreateSecretResultSchema,
    error: ExecutorRpcError,
  }),
  Rpc.make("UpdateSecret", {
    payload: Schema.Struct({
      secretId: Schema.String,
      update: UpdateSecretPayloadSchema,
    }),
    success: UpdateSecretResultSchema,
    error: ExecutorRpcError,
  }),
  Rpc.make("DeleteSecret", {
    payload: Schema.Struct({ secretId: Schema.String }),
    success: DeleteSecretResultSchema,
    error: ExecutorRpcError,
  }),

  // Policies
  Rpc.make("ListPolicies", {
    success: Schema.Array(LocalWorkspacePolicySchema),
    error: ExecutorRpcError,
  }),
  Rpc.make("CreatePolicy", {
    payload: CreatePolicyPayloadSchema,
    success: LocalWorkspacePolicySchema,
    error: ExecutorRpcError,
  }),
  Rpc.make("GetPolicy", {
    payload: Schema.Struct({ policyId: PolicyIdSchema }),
    success: LocalWorkspacePolicySchema,
    error: ExecutorRpcError,
  }),
  Rpc.make("UpdatePolicy", {
    payload: Schema.Struct({
      policyId: PolicyIdSchema,
      update: UpdatePolicyPayloadSchema,
    }),
    success: LocalWorkspacePolicySchema,
    error: ExecutorRpcError,
  }),
  Rpc.make("RemovePolicy", {
    payload: Schema.Struct({ policyId: PolicyIdSchema }),
    success: Schema.Struct({ removed: Schema.Boolean }),
    error: ExecutorRpcError,
  }),

  // Local
  Rpc.make("GetInstallation", {
    success: LocalInstallationSchema,
    error: ExecutorRpcError,
  }),
  Rpc.make("GetConfig", {
    success: InstanceConfigSchema,
    error: ExecutorRpcError,
  }),
  Rpc.make("UpdateConfig", {
    payload: UpdateInstanceConfigPayloadSchema,
    success: InstanceConfigSchema,
    error: ExecutorRpcError,
  }),

  // OAuth
  Rpc.make("StartSourceOAuth", {
    payload: StartSourceOAuthPayloadSchema,
    success: StartSourceOAuthResultSchema,
    error: ExecutorRpcError,
  }),

  // Catalog search
  Rpc.make("SearchTools", {
    payload: ToolSearchPayloadSchema,
    success: ToolSearchResultSetSchema,
    error: ExecutorRpcError,
  }),
);

export type ExecutorRpc = RpcGroup.Rpcs<typeof ExecutorRpcs>;
export type ExecutorRpcTag = ExecutorRpc["_tag"];
