import {
  FetchHttpClient,
  HttpApiClient,
} from "@effect/platform";
import * as Effect from "effect/Effect";

import { EngineApi } from "./api/api";

export const createEngineClient = (input: {
  baseUrl: string;
  accountId?: string;
}) =>
  HttpApiClient.make(EngineApi, {
    baseUrl: input.baseUrl,
  }).pipe(Effect.provide(FetchHttpClient.layer));

export type EngineClient = Effect.Effect.Success<
  ReturnType<typeof createEngineClient>
>;
