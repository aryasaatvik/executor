import { Effect, Match } from "effect";

import { type ExecutionEvent, type ExecutionObserver } from "@executor-js/sdk/core";

import { rememberStart } from "../sdk/bounded-map";

/**
 * Minimal structural view of a Workers Analytics Engine binding. The full type
 * lives in `@cloudflare/workers-types` as a global ambient `interface
 * AnalyticsEngineDataset`, which isn't a named export and would require pulling
 * the Workers global lib into this package's `types`. A local interface keeps
 * the Cloudflare entry self-contained; a real binding satisfies it structurally.
 */
export interface AnalyticsEngineDataset {
  writeDataPoint(event: {
    readonly blobs?: ReadonlyArray<string | ArrayBuffer>;
    readonly doubles?: ReadonlyArray<number>;
    readonly indexes?: ReadonlyArray<string>;
  }): void;
}

/**
 * Build an {@link ExecutionObserver} that writes one Analytics Engine data
 * point per finished execution / tool call. `writeDataPoint` is synchronous,
 * fire-and-forget (no `await`, no `ctx.waitUntil`), so the observer wraps each
 * call in `Effect.sync`. Errors are swallowed by the engine's per-observer
 * suppression — an observer must never break the execution it watches.
 *
 * Layout:
 * - `ExecutionFinished` → blobs `[ "execution", status, trigger? ]`, doubles
 *   `[ durationMs ]`, indexes `[ executionId ]`.
 * - `ToolCallFinished`  → blobs `[ "tool_call", status, path ]`, doubles
 *   `[ durationMs ]`, indexes `[ executionId ]`.
 */
export const createWaeMetricsObserver = (analytics: AnalyticsEngineDataset): ExecutionObserver => {
  const executionStarts = new Map<
    string,
    { readonly startedAt: number; readonly trigger?: string }
  >();
  const toolCallStarts = new Map<string, number>();

  return {
    handle: Match.type<ExecutionEvent>().pipe(
      Match.withReturnType<Effect.Effect<void>>(),
      Match.tag("ExecutionStarted", (event) =>
        Effect.sync(() => {
          rememberStart(executionStarts, event.executionId, {
            startedAt: event.startedAt.getTime(),
            trigger: event.trigger?.kind,
          });
        }),
      ),
      Match.tag("ToolCallStarted", (event) =>
        Effect.sync(() => {
          rememberStart(toolCallStarts, event.toolCallId, event.startedAt.getTime());
        }),
      ),
      Match.tag("ExecutionFinished", (event) =>
        Effect.sync(() => {
          const started = executionStarts.get(event.executionId);
          executionStarts.delete(event.executionId);
          const durationMs = started
            ? Math.max(0, event.completedAt.getTime() - started.startedAt)
            : 0;
          analytics.writeDataPoint({
            blobs: ["execution", event.status, started?.trigger ?? ""],
            doubles: [durationMs],
            indexes: [event.executionId],
          });
        }),
      ),
      Match.tag("ToolCallFinished", (event) =>
        Effect.sync(() => {
          const startedAt = toolCallStarts.get(event.toolCallId);
          toolCallStarts.delete(event.toolCallId);
          const durationMs =
            startedAt !== undefined ? Math.max(0, event.completedAt.getTime() - startedAt) : 0;
          analytics.writeDataPoint({
            blobs: ["tool_call", event.status, event.path],
            doubles: [durationMs],
            indexes: [event.executionId],
          });
        }),
      ),
      Match.tag("InteractionStarted", () => Effect.void),
      Match.tag("InteractionResolved", () => Effect.void),
      Match.exhaustive,
    ),
  };
};
