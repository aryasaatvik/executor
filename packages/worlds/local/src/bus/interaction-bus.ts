import * as Effect from "effect/Effect";
import type { ExecutionInteraction } from "@executor/control-plane/model";
import type { InteractionBusShape } from "@executor/control-plane/ports";

export const createInMemoryInteractionBus = (): InteractionBusShape => {
  const listeners = new Map<string, Set<(interaction: ExecutionInteraction) => void>>();
  const resolved = new Map<string, ExecutionInteraction>();

  return {
    publish: (input) =>
      Effect.sync(() => {
        const subs = listeners.get(input.executionId);
        if (subs) {
          for (const cb of subs) {
            cb(input.interaction);
          }
        }
        if (input.interaction.status === "resolved") {
          resolved.set(input.interaction.id, input.interaction);
        }
      }),

    subscribe: (input) =>
      Effect.sync(() => {
        if (!listeners.has(input.executionId)) {
          listeners.set(input.executionId, new Set());
        }

        const subs = listeners.get(input.executionId)!;
        subs.add(input.onInteraction);

        return {
          unsubscribe: () => {
            subs.delete(input.onInteraction);
          },
        };
      }),

    waitForResolution: (input) =>
      Effect.async<ExecutionInteraction, Error>((resume) => {
        const existing = resolved.get(input.interactionId);
        if (existing) {
          resume(Effect.succeed(existing));
          return;
        }

        if (!listeners.has(input.executionId)) {
          listeners.set(input.executionId, new Set());
        }

        const subs = listeners.get(input.executionId)!;
        const handler = (interaction: ExecutionInteraction) => {
          if (interaction.id === input.interactionId && interaction.status === "resolved") {
            subs.delete(handler);
            resume(Effect.succeed(interaction));
          }
        };

        subs.add(handler);
      }),
  };
};
