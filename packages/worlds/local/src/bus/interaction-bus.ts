import * as Effect from "effect/Effect";
import type { InteractionBusShape } from "@executor/control-plane/ports";

export const createInMemoryInteractionBus = (): InteractionBusShape => ({
  publish: (_input) => Effect.fail(new Error("TODO: implement in-memory interaction bus publish")),
  subscribe: (_input) => Effect.fail(new Error("TODO: implement in-memory interaction bus subscribe")),
  waitForResolution: (_input) => Effect.fail(new Error("TODO: implement in-memory interaction bus waitForResolution")),
});
