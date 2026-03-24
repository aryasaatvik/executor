import type * as RpcClient from "@effect/rpc/RpcClient";
import type { RpcClientError } from "@effect/rpc/RpcClientError";
import type { ExecutorRpcs } from "@executor/engine/rpc";
import type { WorkspaceId, AccountId } from "@executor/engine/schema";

import type { ExecutorEffectApi } from "./effect-api";
import type { Promiseify } from "./promise-wrapper";

/**
 * Typed RPC client produced by `RpcClient.make(ExecutorRpcs)`.
 */
export type ExecutorRpcClient = RpcClient.FromGroup<typeof ExecutorRpcs, RpcClientError>;

/**
 * The executor instance returned by `createExecutor()`.
 */
export type Executor = {
  /** Workspace ID resolved from the server installation. */
  readonly workspaceId: WorkspaceId;
  /** Actor (account) ID resolved from the server installation. */
  readonly actorId: AccountId;
  /** The base URL of the executor server. */
  readonly baseUrl: string;
  /** Namespaced Effect-based API — each method returns an Effect. */
  readonly effect: ExecutorEffectApi;
  /** Promise-based catalog namespace. */
  readonly catalog: Promiseify<ExecutorEffectApi["catalog"]>;
  /** Promise-based sources namespace. */
  readonly sources: Promiseify<ExecutorEffectApi["sources"]>;
  /** Promise-based executions namespace. */
  readonly executions: Promiseify<ExecutorEffectApi["executions"]>;
  /** Promise-based policies namespace. */
  readonly policies: Promiseify<ExecutorEffectApi["policies"]>;
  /** Promise-based local namespace. */
  readonly local: Promiseify<ExecutorEffectApi["local"]>;
  /** Promise-based oauth namespace. */
  readonly oauth: Promiseify<ExecutorEffectApi["oauth"]>;
  /** Raw RPC client — direct access to all RPC methods. */
  readonly rpc: ExecutorRpcClient;
  /** Shut down the underlying RPC client scope. */
  readonly close: () => Promise<void>;
};

/**
 * Options for `createExecutor()`.
 */
export type CreateExecutorOptions = {
  /** Base URL of the executor server (e.g. "http://127.0.0.1:8788"). */
  readonly baseUrl: string;
};
