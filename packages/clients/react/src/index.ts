import { Atom, Result, AtomRpc } from "@effect-atom/atom";
import type * as Registry from "@effect-atom/atom/Registry";
import { RegistryContext, RegistryProvider, useAtomValue, useAtomSet, useAtomRefresh } from "@effect-atom/atom-react";
import { FetchHttpClient } from "@effect/platform";
import * as RpcClient from "@effect/rpc/RpcClient";
import * as RpcSerialization from "@effect/rpc/RpcSerialization";
import { ExecutorRpcs, type ExecutorRpcError } from "@executor/engine/rpc";
import { createEngineClient } from "@executor/engine/client";
import type {
  CompleteSourceOAuthResult,
  ConnectSourceBatchPayload,
  ConnectSourceBatchResult,
  ConnectSourcePayload,
  ConnectSourceResult,
  EngineClient,
  CreateSecretPayload,
  CreateSecretResult,
  CreateSourcePayload,
  CreateWorkspaceOauthClientPayload,
  DeleteSecretResult,
  DiscoverSourcePayload,
  Execution,
  ExecutionStep,
  InstanceConfig,
  LocalInstallation,
  SecretListItem,
  Source,
  SourceDiscoveryResult,
  SourceInspection,
  SourceInspectionDiscoverResult,
  SourceInspectionToolDetail,
  StartSourceOAuthPayload,
  StartSourceOAuthResult,
  UpdateSecretPayload,
  UpdateSecretResult,
  UpdateSourcePayload,
  WorkspaceOauthClient,
} from "@executor/engine";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";
import * as React from "react";

const DEFAULT_EXECUTOR_API_BASE_URL = "http://127.0.0.1:8788";
const RPC_PATH = "/rpc";

// ---------------------------------------------------------------------------
// Loadable type (backward compat)
// ---------------------------------------------------------------------------

export type Loadable<T> =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "ready"; data: T };

const toLoadable = <T>(result: Result.Result<T, unknown>): Loadable<T> => {
  if (Result.isSuccess(result)) {
    return { status: "ready", data: result.value };
  }

  if (Result.isFailure(result)) {
    return { status: "error", error: causeMessage(result.cause) };
  }

  return { status: "loading" };
};

const causeMessage = (cause: Cause.Cause<unknown>): Error =>
  new Error(Cause.pretty(cause));

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

// ---------------------------------------------------------------------------
// Dev error logging
// ---------------------------------------------------------------------------

const shouldLogExecutorDevErrors = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }

  const hostname = window.location.hostname;
  return hostname === "localhost" || hostname === "127.0.0.1";
};

const describeExecutorDevError = (cause: unknown): Record<string, unknown> => {
  if (Runtime.isFiberFailure(cause)) {
    const inner = cause[Runtime.FiberFailureCauseId];
    return {
      name: cause.name,
      message: cause.message,
      cause: Cause.pretty(inner),
    };
  }

  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
      stack: cause.stack,
    };
  }

  return { message: String(cause) };
};

const logExecutorDevError = (label: string, details: Record<string, unknown>): void => {
  if (!shouldLogExecutorDevErrors()) {
    return;
  }

  console.error(`[executor react] ${label}`, details);
};

// ---------------------------------------------------------------------------
// REST client (for operations not yet in the RPC contract)
// ---------------------------------------------------------------------------

const defaultExecutorApiBaseUrl =
  typeof window !== "undefined" && typeof window.location?.origin === "string"
    ? window.location.origin
    : DEFAULT_EXECUTOR_API_BASE_URL;

const toRpcUrl = (baseUrl: string): string =>
  new URL(RPC_PATH, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();

const makeExecutorRpcClient = (baseUrl: string) => {
  class ExecutorRpcClient extends AtomRpc.Tag<ExecutorRpcClient>()(
    `@executor/react/ExecutorRpcClient/${baseUrl}`,
    {
      group: ExecutorRpcs,
      protocol: Layer.mergeAll(
        RpcClient.layerProtocolHttp({ url: toRpcUrl(baseUrl) }).pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(RpcSerialization.layerNdjson),
        ),
      ),
    },
  ) {}

  return ExecutorRpcClient;
};

type ExecutorRpcClientType = ReturnType<typeof makeExecutorRpcClient>;

const executorRpcClientCache = new Map<string, ExecutorRpcClientType>();

const getExecutorRpcClient = (baseUrl: string): ExecutorRpcClientType => {
  const cached = executorRpcClientCache.get(baseUrl);
  if (cached) {
    return cached;
  }

  const created = makeExecutorRpcClient(baseUrl);
  executorRpcClientCache.set(baseUrl, created);
  return created;
};

const runEngine = async <A>(input: {
  baseUrl?: string;
  accountId?: string;
  execute: (client: EngineClient) => Effect.Effect<A, unknown, never>;
}): Promise<A> => {
  const baseUrl = input.baseUrl ?? defaultExecutorApiBaseUrl;
  const accountId = input.accountId;

  const exit = await Effect.runPromiseExit(
    createEngineClient({
      baseUrl,
      ...(accountId !== undefined ? { accountId } : {}),
    }).pipe(Effect.flatMap(input.execute)),
  );

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  const error = Cause.squash(exit.cause);
  logExecutorDevError("control-plane request failed", {
    baseUrl,
    accountId,
    error: describeExecutorDevError(error),
    cause: Cause.pretty(exit.cause),
  });
  throw error;
};

// ---------------------------------------------------------------------------
// Mutation state (backward compat)
// ---------------------------------------------------------------------------

type SourceMutationState<T> = {
  status: "idle" | "pending" | "success" | "error";
  data: T | null;
  error: Error | null;
};

export type SourceRemoveResult = {
  removed: boolean;
};

// ---------------------------------------------------------------------------
// RPC mutation hook helper
// ---------------------------------------------------------------------------

type RpcMutationResult<TInput, TOutput> = {
  status: "idle" | "pending" | "success" | "error";
  data: TOutput | null;
  error: Error | null;
  mutateAsync: (payload: TInput) => Promise<TOutput>;
  reset: () => void;
};

const useRpcMutation = <TInput, TOutput>(
  execute: (payload: TInput) => Promise<TOutput>,
  options?: {
    onSuccess?: () => void;
  },
): RpcMutationResult<TInput, TOutput> => {
  const [state, setState] = React.useState<SourceMutationState<TOutput>>({
    status: "idle",
    data: null,
    error: null,
  });

  const mutateAsync = React.useCallback(async (payload: TInput) => {
    setState((current) => ({
      status: "pending",
      data: current.data,
      error: null,
    }));

    try {
      const data = await execute(payload);
      options?.onSuccess?.();
      setState({ status: "success", data, error: null });
      return data;
    } catch (cause) {
      logExecutorDevError("rpc mutation failed", {
        payload,
        error: describeExecutorDevError(cause),
        cause,
      });
      const error = cause instanceof Error ? cause : new Error(String(cause));
      setState({ status: "error", data: null, error });
      throw error;
    }
  }, [execute, options]);

  const reset = React.useCallback(() => {
    setState({ status: "idle", data: null, error: null });
  }, []);

  return React.useMemo(
    () => ({ ...state, mutateAsync, reset }),
    [mutateAsync, reset, state],
  );
};

// ---------------------------------------------------------------------------
// REST mutation hook helper (for non-RPC operations)
// ---------------------------------------------------------------------------

type WorkspaceContext = {
  installation: LocalInstallation;
  workspaceId: Source["workspaceId"];
  accountId: string;
};

type MutationExecutionContext = {
  workspaceId: Source["workspaceId"];
  accountId: string;
  registry: Registry.Registry;
  invalidateQueries: () => void;
};

type RestMutationOptions<TInput, TOutput> = {
  onSuccess?: (
    context: MutationExecutionContext,
    payload: TInput,
    data: TOutput,
  ) => void;
};

const useRestSourceMutation = <TInput, TOutput>(
  execute: (input: {
    workspaceId: Source["workspaceId"];
    accountId: string;
    payload: TInput;
  }) => Promise<TOutput>,
  options?: RestMutationOptions<TInput, TOutput>,
) => {
  const workspace = useWorkspaceContext();
  const registry = React.useContext(RegistryContext);
  const invalidateExecutorQueries = useInvalidateExecutorQueries();
  const [state, setState] = React.useState<SourceMutationState<TOutput>>({
    status: "idle",
    data: null,
    error: null,
  });

  const mutateAsync = React.useCallback(async (payload: TInput) => {
    if (workspace.status !== "ready") {
      const error = new Error("Executor workspace context is not ready");
      setState({ status: "error", data: null, error });
      throw error;
    }

    setState((current) => ({
      status: "pending",
      data: current.data,
      error: null,
    }));

    const executionContext: MutationExecutionContext = {
      workspaceId: workspace.data.workspaceId,
      accountId: workspace.data.accountId,
      registry,
      invalidateQueries: invalidateExecutorQueries,
    };

    try {
      const data = await execute({
        workspaceId: workspace.data.workspaceId,
        accountId: workspace.data.accountId,
        payload,
      });
      options?.onSuccess?.(executionContext, payload, data);
      setState({ status: "success", data, error: null });
      return data;
    } catch (cause) {
      logExecutorDevError("source mutation failed", {
        workspaceId: workspace.data.workspaceId,
        accountId: workspace.data.accountId,
        payload,
        error: describeExecutorDevError(cause),
        cause,
      });
      const error = cause instanceof Error ? cause : new Error(String(cause));
      setState({ status: "error", data: null, error });
      throw error;
    }
  }, [execute, invalidateExecutorQueries, options, registry, workspace]);

  const reset = React.useCallback(() => {
    setState({ status: "idle", data: null, error: null });
  }, []);

  return React.useMemo(
    () => ({ ...state, mutateAsync, reset }),
    [mutateAsync, reset, state],
  );
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

type ExecutorApiContextValue = {
  baseUrl: string;
  invalidateQueries: () => void;
  invalidationVersion: number;
  rpcClient: ExecutorRpcClientType;
};

const ExecutorApiContext = React.createContext<ExecutorApiContextValue | null>(null);

const useExecutorApiContext = (): ExecutorApiContextValue => {
  const context = React.useContext(ExecutorApiContext);
  if (context === null) {
    throw new Error("ExecutorReactProvider is missing from the React tree");
  }
  return context;
};

const useExecutorApiBaseUrl = (): string => useExecutorApiContext().baseUrl;
const useExecutorRpcClient = (): ExecutorRpcClientType => useExecutorApiContext().rpcClient;
const useExecutorInvalidationVersion = (): number =>
  useExecutorApiContext().invalidationVersion;

const ExecutorReactProviderInner = (
  props: React.PropsWithChildren<{ baseUrl: string }>,
) => {
  const [invalidationVersion, bumpInvalidationVersion] = React.useReducer(
    (current: number) => current + 1,
    0,
  );
  const invalidateQueries = React.useCallback(() => {
    bumpInvalidationVersion();
  }, []);
  const apiValue = React.useMemo<ExecutorApiContextValue>(() => ({
    baseUrl: props.baseUrl,
    invalidateQueries,
    invalidationVersion,
    rpcClient: getExecutorRpcClient(props.baseUrl),
  }), [props.baseUrl, invalidateQueries, invalidationVersion]);

  return React.createElement(
    ExecutorApiContext.Provider,
    { value: apiValue },
    props.children,
  );
};

export const ExecutorReactProvider = (props: React.PropsWithChildren<{ baseUrl?: string }>) =>
  React.createElement(
    RegistryProvider,
    null,
    React.createElement(
      ExecutorReactProviderInner,
      { baseUrl: props.baseUrl ?? defaultExecutorApiBaseUrl },
      props.children,
    ),
  );

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

const useRpcQuery = <T>(atom: Atom.Atom<Result.Result<T, unknown>>): Loadable<T> => {
  const result = useAtomValue(atom);
  return React.useMemo(() => toLoadable(result), [result]);
};

// Bootstrap query — needed to resolve workspace context for REST-only mutations
const useWorkspaceContext = (): Loadable<WorkspaceContext> => {
  const installation = useLocalInstallation();

  return React.useMemo(() => {
    if (installation.status !== "ready") {
      return installation;
    }

    return {
      status: "ready",
      data: {
        installation: installation.data,
        workspaceId: installation.data.workspaceId,
        accountId: installation.data.accountId,
      },
    } satisfies Loadable<WorkspaceContext>;
  }, [installation]);
};

export const useLocalInstallation = (): Loadable<LocalInstallation> =>
  useRpcQuery(useExecutorRpcClient().query("GetInstallation", void 0 as void));

export const useInstanceConfig = (): Loadable<InstanceConfig> =>
  useRpcQuery(useExecutorRpcClient().query("GetConfig", void 0 as void));

export const useRefreshInstanceConfig = (): (() => void) =>
  useAtomRefresh(useExecutorRpcClient().query("GetConfig", void 0 as void));

export const useSecrets = (): Loadable<ReadonlyArray<SecretListItem>> =>
  useRpcQuery(useExecutorRpcClient().query("ListSecrets", void 0 as void));

export const useRefreshSecrets = (): (() => void) =>
  useAtomRefresh(useExecutorRpcClient().query("ListSecrets", void 0 as void));

export const useSources = (): Loadable<ReadonlyArray<Source>> =>
  useRpcQuery(useExecutorRpcClient().query("ListSources", void 0 as void));

export const useSource = (sourceId: string): Loadable<Source> => {
  const rpcClient = useExecutorRpcClient();
  return useRpcQuery(
    rpcClient.query("GetSource", { sourceId: sourceId as Source["id"] }),
  );
};

export const useSourceInspection = (sourceId: string): Loadable<SourceInspection> => {
  const rpcClient = useExecutorRpcClient();
  return useRpcQuery(
    rpcClient.query("GetSourceInspection", { sourceId: sourceId as Source["id"] }),
  );
};

export const useSourceToolDetail = (
  sourceId: string,
  toolPath: string | null,
): Loadable<SourceInspectionToolDetail | null> => {
  const rpcClient = useExecutorRpcClient();
  const queryAtom = React.useMemo(
    () =>
      toolPath !== null
        ? rpcClient.query("GetSourceInspectionToolDetail", {
            sourceId: sourceId as Source["id"],
            toolPath,
          })
        : Atom.make(Result.success<SourceInspectionToolDetail | null, never>(null)),
    [rpcClient, sourceId, toolPath],
  );

  return useRpcQuery(queryAtom);
};

export const useSourceDiscovery = (input: {
  sourceId: string;
  query: string;
  limit?: number;
}): Loadable<SourceInspectionDiscoverResult> => {
  const rpcClient = useExecutorRpcClient();
  const emptyResult: SourceInspectionDiscoverResult = React.useMemo(
    () => ({
      query: "",
      queryTokens: [],
      bestPath: null,
      total: 0,
      results: [],
    }),
    [],
  );

  const queryAtom = React.useMemo(
    () =>
      input.query.trim().length === 0
        ? Atom.make(Result.success<SourceInspectionDiscoverResult, never>(emptyResult))
        : rpcClient.query("DiscoverSourceInspectionTools", {
            sourceId: input.sourceId as Source["id"],
            discover: {
              query: input.query,
              ...(input.limit !== undefined ? { limit: input.limit } : {}),
            },
          }),
    [emptyResult, input.limit, input.query, input.sourceId, rpcClient],
  );

  return useRpcQuery(queryAtom);
};

export const useExecutions = (): Loadable<ReadonlyArray<Execution>> =>
  useRpcQuery(useExecutorRpcClient().query("ListExecutions", void 0 as void));

export const useExecutionSteps = (executionId: string): Loadable<ReadonlyArray<ExecutionStep>> => {
  const rpcClient = useExecutorRpcClient();
  const queryAtom = React.useMemo(
    () =>
      executionId.length > 0
        ? rpcClient.query("ListExecutionSteps", {
            executionId: executionId as any,
          })
        : Atom.make(Result.success<ReadonlyArray<ExecutionStep>, never>([])),
    [executionId, rpcClient],
  );

  return useRpcQuery(queryAtom);
};

export const useWorkspaceOauthClients = (
  providerKey: string | null,
): Loadable<ReadonlyArray<WorkspaceOauthClient>> => {
  const baseUrl = useExecutorApiBaseUrl();
  const invalidationVersion = useExecutorInvalidationVersion();
  const workspace = useWorkspaceContext();

  const [state, setState] = React.useState<Loadable<ReadonlyArray<WorkspaceOauthClient>>>({
    status: "loading",
  });

  React.useEffect(() => {
    if (workspace.status !== "ready" || providerKey === null) {
      if (providerKey === null && workspace.status === "ready") {
        setState({ status: "ready", data: [] });
      } else if (workspace.status === "error") {
        setState({ status: "error", error: workspace.error });
      } else {
        setState({ status: "loading" });
      }
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });

    runEngine({
      baseUrl,
      accountId: workspace.data.accountId,
      execute: (client) =>
        client.sources.listWorkspaceOauthClients({
          path: { workspaceId: workspace.data.workspaceId },
          urlParams: { providerKey },
        }),
    }).then(
      (data) => { if (!cancelled) setState({ status: "ready", data }); },
      (error) => { if (!cancelled) setState({ status: "error", error: toError(error) }); },
    );

    return () => { cancelled = true; };
  }, [baseUrl, invalidationVersion, providerKey, workspace]);

  return state;
};

export const usePrefetchToolDetail = () => {
  const registry = React.useContext(RegistryContext);
  const rpcClient = useExecutorRpcClient();

  return React.useCallback(
    (sourceId: string, toolPath: string): (() => void) => {
      const atom = rpcClient.query("GetSourceInspectionToolDetail", {
        sourceId: sourceId as Source["id"],
        toolPath,
      });
      return registry.mount(atom);
    },
    [registry, rpcClient],
  );
};

export const useInvalidateExecutorQueries = (): (() => void) => {
  const registry = React.useContext(RegistryContext);
  const { invalidateQueries } = useExecutorApiContext();

  return React.useCallback(() => {
    registry.reset();
    invalidateQueries();
  }, [invalidateQueries, registry]);
};

// ---------------------------------------------------------------------------
// RPC mutation hooks
// ---------------------------------------------------------------------------

export const useCreateSource = () => {
  const rpcClient = useExecutorRpcClient();
  const refreshSources = useAtomRefresh(rpcClient.query("ListSources", void 0 as void));
  const mutate = useAtomSet(rpcClient.mutation("CreateSource"), { mode: "promiseExit" });

  return useRpcMutation<CreateSourcePayload, Source>(
    React.useCallback(
      async (payload: CreateSourcePayload) => {
        const exit = await mutate({ payload });
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
        return exit.value;
      },
      [mutate],
    ),
    React.useMemo(() => ({ onSuccess: refreshSources }), [refreshSources]),
  );
};

export const useUpdateSource = () => {
  const rpcClient = useExecutorRpcClient();
  const refreshSources = useAtomRefresh(rpcClient.query("ListSources", void 0 as void));
  const mutate = useAtomSet(rpcClient.mutation("UpdateSource"), { mode: "promiseExit" });

  return useRpcMutation<{ sourceId: Source["id"]; payload: UpdateSourcePayload }, Source>(
    React.useCallback(
      async (input: { sourceId: Source["id"]; payload: UpdateSourcePayload }) => {
        const exit = await mutate({
          payload: { sourceId: input.sourceId, update: input.payload },
        });
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
        return exit.value;
      },
      [mutate],
    ),
    React.useMemo(() => ({ onSuccess: refreshSources }), [refreshSources]),
  );
};

export const useRemoveSource = () => {
  const rpcClient = useExecutorRpcClient();
  const refreshSources = useAtomRefresh(rpcClient.query("ListSources", void 0 as void));
  const mutate = useAtomSet(rpcClient.mutation("RemoveSource"), { mode: "promiseExit" });

  return useRpcMutation<Source["id"], SourceRemoveResult>(
    React.useCallback(
      async (sourceId: Source["id"]) => {
        const exit = await mutate({ payload: { sourceId } });
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
        return exit.value;
      },
      [mutate],
    ),
    React.useMemo(() => ({ onSuccess: refreshSources }), [refreshSources]),
  );
};

export const useDiscoverSource = () => {
  const rpcClient = useExecutorRpcClient();
  const mutate = useAtomSet(rpcClient.mutation("DiscoverSource"), { mode: "promiseExit" });

  return useRpcMutation<DiscoverSourcePayload, SourceDiscoveryResult>(
    React.useCallback(
      async (payload: DiscoverSourcePayload) => {
        const exit = await mutate({ payload });
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
        return exit.value;
      },
      [mutate],
    ),
  );
};

export const useConnectSource = () => {
  const rpcClient = useExecutorRpcClient();
  const refreshSources = useAtomRefresh(rpcClient.query("ListSources", void 0 as void));
  const mutate = useAtomSet(rpcClient.mutation("ConnectSource"), { mode: "promiseExit" });

  return useRpcMutation<ConnectSourcePayload, ConnectSourceResult>(
    React.useCallback(
      async (payload: ConnectSourcePayload) => {
        const exit = await mutate({ payload: payload as any });
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
        return exit.value;
      },
      [mutate],
    ),
    React.useMemo(() => ({ onSuccess: refreshSources }), [refreshSources]),
  );
};

export const useConnectSourceBatch = () => {
  const rpcClient = useExecutorRpcClient();
  const refreshSources = useAtomRefresh(rpcClient.query("ListSources", void 0 as void));
  const mutate = useAtomSet(rpcClient.mutation("ConnectSourceBatch"), { mode: "promiseExit" });

  return useRpcMutation<ConnectSourceBatchPayload, ConnectSourceBatchResult>(
    React.useCallback(
      async (payload: ConnectSourceBatchPayload) => {
        const exit = await mutate({ payload });
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
        return exit.value;
      },
      [mutate],
    ),
    React.useMemo(() => ({ onSuccess: refreshSources }), [refreshSources]),
  );
};

export const useStartSourceOAuth = () => {
  const rpcClient = useExecutorRpcClient();
  const mutate = useAtomSet(rpcClient.mutation("StartSourceOAuth"), { mode: "promiseExit" });

  return useRpcMutation<StartSourceOAuthPayload, StartSourceOAuthResult>(
    React.useCallback(
      async (payload: StartSourceOAuthPayload) => {
        const exit = await mutate({ payload });
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
        return exit.value;
      },
      [mutate],
    ),
  );
};

// ---------------------------------------------------------------------------
// Secret / config mutation hooks
// ---------------------------------------------------------------------------

export const useCreateSecret = () => {
  const rpcClient = useExecutorRpcClient();
  const refreshSecrets = useAtomRefresh(rpcClient.query("ListSecrets", void 0 as void));
  const mutate = useAtomSet(rpcClient.mutation("CreateSecret"), { mode: "promiseExit" });

  return useRpcMutation<CreateSecretPayload, CreateSecretResult>(
    React.useCallback(
      async (payload: CreateSecretPayload) => {
        const exit = await mutate({ payload });
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
        return exit.value;
      },
      [mutate],
    ),
    React.useMemo(() => ({ onSuccess: refreshSecrets }), [refreshSecrets]),
  );
};

export const useUpdateSecret = () => {
  const rpcClient = useExecutorRpcClient();
  const refreshSecrets = useAtomRefresh(rpcClient.query("ListSecrets", void 0 as void));
  const mutate = useAtomSet(rpcClient.mutation("UpdateSecret"), { mode: "promiseExit" });

  return useRpcMutation<{ secretId: string; payload: UpdateSecretPayload }, UpdateSecretResult>(
    React.useCallback(
      async (input: { secretId: string; payload: UpdateSecretPayload }) => {
        const exit = await mutate({
          payload: { secretId: input.secretId, update: input.payload },
        });
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
        return exit.value;
      },
      [mutate],
    ),
    React.useMemo(() => ({ onSuccess: refreshSecrets }), [refreshSecrets]),
  );
};

export const useDeleteSecret = () => {
  const rpcClient = useExecutorRpcClient();
  const refreshSecrets = useAtomRefresh(rpcClient.query("ListSecrets", void 0 as void));
  const mutate = useAtomSet(rpcClient.mutation("DeleteSecret"), { mode: "promiseExit" });

  return useRpcMutation<string, DeleteSecretResult>(
    React.useCallback(
      async (secretId: string) => {
        const exit = await mutate({ payload: { secretId } });
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
        return exit.value;
      },
      [mutate],
    ),
    React.useMemo(() => ({ onSuccess: refreshSecrets }), [refreshSecrets]),
  );
};

export const useUpdateInstanceConfig = () => {
  const rpcClient = useExecutorRpcClient();
  const refreshConfig = useAtomRefresh(rpcClient.query("GetConfig", void 0 as void));
  const mutate = useAtomSet(rpcClient.mutation("UpdateConfig"), { mode: "promiseExit" });

  type UpdateInstanceConfigPayload = {
    semanticSearch: InstanceConfig["semanticSearch"];
  };

  return useRpcMutation<UpdateInstanceConfigPayload, InstanceConfig>(
    React.useCallback(
      async (payload: UpdateInstanceConfigPayload) => {
        const exit = await mutate({ payload });
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
        return exit.value;
      },
      [mutate],
    ),
    React.useMemo(() => ({ onSuccess: refreshConfig }), [refreshConfig]),
  );
};

// ---------------------------------------------------------------------------
// REST-only mutation hooks (not yet in RPC contract)
// ---------------------------------------------------------------------------

export const useCreateWorkspaceOauthClient = () => {
  const baseUrl = useExecutorApiBaseUrl();
  const execute = React.useCallback(
    ({ workspaceId, accountId, payload }: {
      workspaceId: Source["workspaceId"];
      accountId: string;
      payload: CreateWorkspaceOauthClientPayload;
    }) =>
      runEngine({
        baseUrl,
        accountId,
        execute: (client) =>
          client.sources.createWorkspaceOauthClient({
            path: { workspaceId },
            payload,
          }),
      }),
    [baseUrl],
  );

  return useRestSourceMutation<CreateWorkspaceOauthClientPayload, WorkspaceOauthClient>(
    execute,
    React.useMemo(
      () => ({
        onSuccess: (context) => {
          context.invalidateQueries();
        },
      }),
      [],
    ),
  );
};

export const useRemoveWorkspaceOauthClient = () => {
  const baseUrl = useExecutorApiBaseUrl();
  const execute = React.useCallback(
    ({ workspaceId, accountId, payload }: {
      workspaceId: Source["workspaceId"];
      accountId: string;
      payload: WorkspaceOauthClient["id"];
    }) =>
      runEngine({
        baseUrl,
        accountId,
        execute: (client) =>
          client.sources.removeWorkspaceOauthClient({
            path: { workspaceId, oauthClientId: payload },
          }),
      }),
    [baseUrl],
  );

  return useRestSourceMutation<WorkspaceOauthClient["id"], { removed: boolean }>(
    execute,
    React.useMemo(
      () => ({
        onSuccess: (context) => {
          context.invalidateQueries();
        },
      }),
      [],
    ),
  );
};

export const useRemoveProviderAuthGrant = () => {
  const baseUrl = useExecutorApiBaseUrl();
  const execute = React.useCallback(
    ({ workspaceId, accountId, payload }: {
      workspaceId: Source["workspaceId"];
      accountId: string;
      payload: Extract<Source["auth"], { kind: "provider_grant_ref" }>["grantId"];
    }) =>
      runEngine({
        baseUrl,
        accountId,
        execute: (client) =>
          client.sources.removeProviderAuthGrant({
            path: { workspaceId, grantId: payload },
          }),
      }),
    [baseUrl],
  );

  return useRestSourceMutation<
    Extract<Source["auth"], { kind: "provider_grant_ref" }>["grantId"],
    { removed: boolean }
  >(
    execute,
    React.useMemo(
      () => ({
        onSuccess: (context) => {
          context.invalidateQueries();
        },
      }),
      [],
    ),
  );
};

// ---------------------------------------------------------------------------
// Type re-exports (backward compat)
// ---------------------------------------------------------------------------

export type {
  CompleteSourceOAuthResult,
  ConnectSourceBatchPayload,
  ConnectSourceBatchResult,
  ConnectSourcePayload,
  ConnectSourceResult,
  CreateSecretPayload,
  CreateSecretResult,
  CreateSourcePayload,
  CreateWorkspaceOauthClientPayload,
  DeleteSecretResult,
  DiscoverSourcePayload,
  Execution,
  ExecutionStep,
  InstanceConfig,
  LocalInstallation,
  SecretListItem,
  Source,
  SourceDiscoveryResult,
  SourceInspection,
  SourceInspectionDiscoverResult,
  SourceInspectionToolDetail,
  StartSourceOAuthPayload,
  StartSourceOAuthResult,
  UpdateSecretPayload,
  UpdateSecretResult,
  UpdateSourcePayload,
  WorkspaceOauthClient,
};
