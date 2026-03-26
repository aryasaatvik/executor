import {
  HttpApiBuilder,
  HttpApiClient,
} from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  EngineApi,
  createEngineApiLayer,
} from "#api";

import {
  type EngineRuntime,
} from "../index";

const createClientLayer = (runtime: EngineRuntime) => {
  const apiLayer = createEngineApiLayer(runtime.runtimeLayer);

  return HttpApiBuilder.serve().pipe(
    Layer.provide(apiLayer),
    Layer.provideMerge(NodeHttpServer.layerTest),
  );
};

const createEngineClient = () =>
  HttpApiClient.make(EngineApi, {
  });

type EngineClient = Effect.Effect.Success<
  ReturnType<typeof createEngineClient>
>;

export const withEngineClient = <A, E>(
  input: {
    runtime: EngineRuntime;
    accountId?: string;
  },
  f: (client: EngineClient) => Effect.Effect<A, E, never>,
): Effect.Effect<A, E, never> =>
  Effect.gen(function* () {
    const client = yield* createEngineClient();
    return yield* f(client);
  }).pipe(Effect.provide(createClientLayer(input.runtime).pipe(Layer.orDie)));
