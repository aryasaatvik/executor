import { HttpApiBuilder } from "@effect/platform";
import * as Layer from "effect/Layer";

import { EngineApi } from "./api";
import { EngineExecutionsLive } from "./executions/http";
import { EngineLocalLive } from "./local/http";
import { EngineOAuthLive } from "./oauth/http";
import { EnginePoliciesLive } from "./policies/http";
import { EngineSourcesLive } from "./sources/http";

export const EngineApiLive = HttpApiBuilder.api(EngineApi).pipe(
  Layer.provide(EngineLocalLive),
  Layer.provide(EngineOAuthLive),
  Layer.provide(EngineSourcesLive),
  Layer.provide(EnginePoliciesLive),
  Layer.provide(EngineExecutionsLive),
);

export type EngineRuntimeContext = Layer.Layer.Context<typeof EngineApiLive>;

export type BuiltEngineApiLayer = Layer.Layer<
  Layer.Layer.Success<typeof EngineApiLive>,
  Layer.Layer.Error<typeof EngineApiLive>,
  never
>;

export const createEngineApiLayer = <ERuntime>(
  runtimeLayer: Layer.Layer<EngineRuntimeContext, ERuntime, never>,
) =>
  EngineApiLive.pipe(
    Layer.provide(runtimeLayer),
  );
