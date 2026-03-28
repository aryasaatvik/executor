import { FetchHttpClient } from "@effect/platform";
import * as RpcClient from "@effect/rpc/RpcClient";
import * as RpcSerialization from "@effect/rpc/RpcSerialization";
import { ExecutorRpcs } from "@executor/rpc";
import type { WorkspaceId, AccountId } from "@executor/core/model";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import { createEffectApi } from "./effect-api";
import { wrapEffectApi } from "./promise-wrapper";
import type { Executor, CreateExecutorOptions } from "./types";

const run = <A>(effect: Effect.Effect<A, any, never>): Promise<A> =>
  Effect.runPromise(effect);

const toRpcUrl = (baseUrl: string): string =>
  new URL("/rpc", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();

/**
 * Create an Executor client connected to an executor server via RPC.
 *
 * Connects to `baseUrl/rpc`, fetches the server installation to resolve
 * `workspaceId` and `actorId`, then returns an {@link Executor} instance
 * with both Effect-based and Promise-based namespaced APIs.
 *
 * Call `executor.close()` when done to release resources.
 */
export const createExecutor = async (
  options: CreateExecutorOptions,
): Promise<Executor> => {
  const rpcUrl = toRpcUrl(options.baseUrl);

  const protocolLayer = RpcClient.layerProtocolHttp({ url: rpcUrl }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(RpcSerialization.layerNdjson),
  );

  // Create a long-lived scope to keep the RPC client alive.
  const scope = Effect.runSync(Scope.make());
  try {
    const client = await Effect.runPromise(
      RpcClient.make(ExecutorRpcs).pipe(
        Effect.provide(protocolLayer),
        Effect.provideService(Scope.Scope, scope),
      ),
    );

    const installation = await Effect.runPromise(
      client.GetInstallation(void 0 as void),
    );

    const effectApi = createEffectApi(client);

    return {
      workspaceId: installation.workspaceId as WorkspaceId,
      actorId: installation.accountId as AccountId,
      baseUrl: options.baseUrl,
      effect: effectApi,
      catalog: wrapEffectApi(effectApi.catalog, run),
      sources: wrapEffectApi(effectApi.sources, run),
      executions: wrapEffectApi(effectApi.executions, run),
      policies: wrapEffectApi(effectApi.policies, run),
      local: wrapEffectApi(effectApi.local, run),
      oauth: wrapEffectApi(effectApi.oauth, run),
      rpc: client,
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  } catch (cause) {
    try {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    } catch {
      // Preserve the original initialization failure.
    }
    throw cause;
  }
};
