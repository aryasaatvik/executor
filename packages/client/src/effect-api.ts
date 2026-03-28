import type * as Effect from "effect/Effect";
import type { RpcClientError } from "@effect/rpc/RpcClientError";
import type { ExecutorRpcError } from "@executor/rpc";
import type * as Rpc from "@effect/rpc/Rpc";
import type { ExecutorRpc } from "@executor/rpc";
import type { ExecutorRpcClient } from "./types";

// ---------------------------------------------------------------------------
// Type helpers — derive payload/success from the RPC contract
// ---------------------------------------------------------------------------

type Err = ExecutorRpcError | RpcClientError;

type RpcPayload<Tag extends ExecutorRpc["_tag"]> =
  Rpc.Payload<Extract<ExecutorRpc, { readonly _tag: Tag }>>;

type RpcSuccess<Tag extends ExecutorRpc["_tag"]> =
  Rpc.Success<Extract<ExecutorRpc, { readonly _tag: Tag }>>;

// ---------------------------------------------------------------------------
// Effect API — namespaced, clean argument signatures
// ---------------------------------------------------------------------------

export type ExecutorEffectApi = {
  readonly catalog: {
    readonly search: (payload: RpcPayload<"SearchTools">) => Effect.Effect<RpcSuccess<"SearchTools">, Err>;
  };
  readonly sources: {
    readonly list: () => Effect.Effect<RpcSuccess<"ListSources">, Err>;
    readonly get: (sourceId: RpcPayload<"GetSource">["sourceId"]) => Effect.Effect<RpcSuccess<"GetSource">, Err>;
    readonly create: (payload: RpcPayload<"CreateSource">) => Effect.Effect<RpcSuccess<"CreateSource">, Err>;
    readonly update: (sourceId: RpcPayload<"UpdateSource">["sourceId"], payload: RpcPayload<"UpdateSource">["update"]) => Effect.Effect<RpcSuccess<"UpdateSource">, Err>;
    readonly remove: (sourceId: RpcPayload<"RemoveSource">["sourceId"]) => Effect.Effect<RpcSuccess<"RemoveSource">, Err>;
    readonly discover: (payload: RpcPayload<"DiscoverSource">) => Effect.Effect<RpcSuccess<"DiscoverSource">, Err>;
    readonly connect: (payload: RpcPayload<"ConnectSource">) => Effect.Effect<RpcSuccess<"ConnectSource">, Err>;
    readonly connectBatch: (payload: RpcPayload<"ConnectSourceBatch">) => Effect.Effect<RpcSuccess<"ConnectSourceBatch">, Err>;
    readonly inspection: {
      readonly get: (sourceId: RpcPayload<"GetSourceInspection">["sourceId"]) => Effect.Effect<RpcSuccess<"GetSourceInspection">, Err>;
      readonly tool: (sourceId: RpcPayload<"GetSourceInspectionToolDetail">["sourceId"], toolPath: string) => Effect.Effect<RpcSuccess<"GetSourceInspectionToolDetail">, Err>;
      readonly discover: (sourceId: RpcPayload<"DiscoverSourceInspectionTools">["sourceId"], payload: RpcPayload<"DiscoverSourceInspectionTools">["discover"]) => Effect.Effect<RpcSuccess<"DiscoverSourceInspectionTools">, Err>;
    };
  };
  readonly executions: {
    readonly list: () => Effect.Effect<RpcSuccess<"ListExecutions">, Err>;
    readonly create: (payload: RpcPayload<"CreateExecution">) => Effect.Effect<RpcSuccess<"CreateExecution">, Err>;
    readonly get: (executionId: RpcPayload<"GetExecution">["executionId"]) => Effect.Effect<RpcSuccess<"GetExecution">, Err>;
    readonly resume: (executionId: RpcPayload<"ResumeExecution">["executionId"], payload: RpcPayload<"ResumeExecution">["resume"]) => Effect.Effect<RpcSuccess<"ResumeExecution">, Err>;
    readonly steps: (executionId: RpcPayload<"ListExecutionSteps">["executionId"]) => Effect.Effect<RpcSuccess<"ListExecutionSteps">, Err>;
    readonly closeSession: (executionSessionId: RpcPayload<"CloseExecutionSession">["executionSessionId"]) => Effect.Effect<RpcSuccess<"CloseExecutionSession">, Err>;
  };
  readonly policies: {
    readonly list: () => Effect.Effect<RpcSuccess<"ListPolicies">, Err>;
    readonly create: (payload: RpcPayload<"CreatePolicy">) => Effect.Effect<RpcSuccess<"CreatePolicy">, Err>;
    readonly get: (policyId: RpcPayload<"GetPolicy">["policyId"]) => Effect.Effect<RpcSuccess<"GetPolicy">, Err>;
    readonly update: (policyId: RpcPayload<"UpdatePolicy">["policyId"], payload: RpcPayload<"UpdatePolicy">["update"]) => Effect.Effect<RpcSuccess<"UpdatePolicy">, Err>;
    readonly remove: (policyId: RpcPayload<"RemovePolicy">["policyId"]) => Effect.Effect<RpcSuccess<"RemovePolicy">, Err>;
  };
  readonly local: {
    readonly installation: () => Effect.Effect<RpcSuccess<"GetInstallation">, Err>;
  };
  readonly oauth: {
    readonly startSourceAuth: (payload: RpcPayload<"StartSourceOAuth">) => Effect.Effect<RpcSuccess<"StartSourceOAuth">, Err>;
  };
};

// ---------------------------------------------------------------------------
// Build the Effect API from an RPC client
// ---------------------------------------------------------------------------

export const createEffectApi = (
  client: ExecutorRpcClient,
): ExecutorEffectApi => ({
  catalog: {
    search: (payload) => client.SearchTools(payload),
  },
  sources: {
    list: () => client.ListSources(void 0 as void),
    get: (sourceId) => client.GetSource({ sourceId }),
    create: (payload) => client.CreateSource(payload),
    update: (sourceId, payload) => client.UpdateSource({ sourceId, update: payload }),
    remove: (sourceId) => client.RemoveSource({ sourceId }),
    discover: (payload) => client.DiscoverSource(payload),
    connect: (payload) => client.ConnectSource(payload),
    connectBatch: (payload) => client.ConnectSourceBatch(payload),
    inspection: {
      get: (sourceId) => client.GetSourceInspection({ sourceId }),
      tool: (sourceId, toolPath) => client.GetSourceInspectionToolDetail({ sourceId, toolPath }),
      discover: (sourceId, payload) => client.DiscoverSourceInspectionTools({ sourceId, discover: payload }),
    },
  },
  executions: {
    list: () => client.ListExecutions(void 0 as void),
    create: (payload) => client.CreateExecution(payload),
    get: (executionId) => client.GetExecution({ executionId }),
    resume: (executionId, payload) => client.ResumeExecution({ executionId, resume: payload }),
    steps: (executionId) => client.ListExecutionSteps({ executionId }),
    closeSession: (executionSessionId) => client.CloseExecutionSession({ executionSessionId }),
  },
  policies: {
    list: () => client.ListPolicies(void 0 as void),
    create: (payload) => client.CreatePolicy(payload),
    get: (policyId) => client.GetPolicy({ policyId }),
    update: (policyId, payload) => client.UpdatePolicy({ policyId, update: payload }),
    remove: (policyId) => client.RemovePolicy({ policyId }),
  },
  local: {
    installation: () => client.GetInstallation(void 0 as void),
  },
  oauth: {
    startSourceAuth: (payload) => client.StartSourceOAuth(payload),
  },
});
