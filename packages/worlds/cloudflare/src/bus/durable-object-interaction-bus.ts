import * as Effect from "effect/Effect";
import type { InteractionBusShape } from "@executor/control-plane/ports";

// TODO: Implement with Durable Objects in Phase 6

export const createDurableObjectInteractionBus = (): InteractionBusShape => ({
  publish: (_input) => Effect.fail(new Error("TODO: implement DO interaction bus publish")),
  subscribe: (_input) => Effect.fail(new Error("TODO: implement DO interaction bus subscribe")),
  waitForResolution: (_input) => Effect.fail(new Error("TODO: implement DO interaction bus waitForResolution")),
});
