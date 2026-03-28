import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ExecutionId, ExecutionInteraction } from "../model/index";

// TODO: Migrate to ServiceMap.Service when moving to Effect v4

export interface InteractionBusShape {
  readonly publish: (input: {
    executionId: ExecutionId;
    interaction: ExecutionInteraction;
  }) => Effect.Effect<void, Error>;

  readonly subscribe: (input: {
    executionId: ExecutionId;
    onInteraction: (interaction: ExecutionInteraction) => void;
  }) => Effect.Effect<{ unsubscribe: () => void }, Error>;

  readonly waitForResolution: (input: {
    executionId: ExecutionId;
    interactionId: string;
  }) => Effect.Effect<ExecutionInteraction, Error>;
}

export class InteractionBus extends Context.Tag(
  "@executor/core/InteractionBus",
)<InteractionBus, InteractionBusShape>() {}
