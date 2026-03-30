import { HttpApiBuilder } from "@effect/platform";
import * as Layer from "effect/Layer";

import { ExecutorApi } from "./api";
import { ExecutorExecutionsLive } from "./executions/http";
import { ExecutorLocalLive } from "./local/http";
import { ExecutorOAuthLive } from "./oauth/http";
import { ExecutorPoliciesLive } from "./policies/http";
import { ExecutorSourcesLive } from "./sources/http";

export const ExecutorApiLive = HttpApiBuilder.api(ExecutorApi).pipe(
  Layer.provide(ExecutorLocalLive),
  Layer.provide(ExecutorOAuthLive),
  Layer.provide(ExecutorSourcesLive),
  Layer.provide(ExecutorPoliciesLive),
  Layer.provide(ExecutorExecutionsLive),
);

export type ExecutorRuntimeContext = Layer.Layer.Context<typeof ExecutorApiLive>;

export type BuiltExecutorApiLayer = Layer.Layer<
  Layer.Layer.Success<typeof ExecutorApiLive>,
  Layer.Layer.Error<typeof ExecutorApiLive>,
  never
>;

export const createExecutorApiLayer = <ERuntime>(
  runtimeLayer: Layer.Layer<ExecutorRuntimeContext, ERuntime, never>,
) =>
  ExecutorApiLive.pipe(
    Layer.provide(runtimeLayer),
  );
