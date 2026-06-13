import { Effect, Metric, Predicate } from "effect";

import {
  type ExecutionEvent,
  type ExecutionId,
  type ExecutionObserver,
} from "@executor-js/sdk/core";

// ---------------------------------------------------------------------------
// Metric definitions — registered in the global Effect Metric registry the
// first time this module is loaded. The Prometheus scrape (`../api/prometheus`)
// and the Effect OTLP/Prometheus exporters read the same registry.
// ---------------------------------------------------------------------------

const executionsStarted = Metric.counter("executor.execution.started_total", {
  description: "Executor executions started.",
  incremental: true,
});

const executionsCompleted = Metric.counter("executor.execution.completed_total", {
  description: "Executor executions completed.",
  incremental: true,
});

const executionsFailed = Metric.counter("executor.execution.failed_total", {
  description: "Executor executions failed.",
  incremental: true,
});

const executionDuration = Metric.histogram("executor.execution.duration_ms", {
  description: "Executor execution duration in milliseconds.",
  boundaries: Metric.exponentialBoundaries({ start: 1, factor: 2, count: 16 }),
});

const toolCallsStarted = Metric.counter("executor.tool_call.started_total", {
  description: "Executor tool calls started.",
  incremental: true,
});

const toolCallsCompleted = Metric.counter("executor.tool_call.completed_total", {
  description: "Executor tool calls completed.",
  incremental: true,
});

const toolCallsFailed = Metric.counter("executor.tool_call.failed_total", {
  description: "Executor tool calls failed.",
  incremental: true,
});

const triggerAttributes = (triggerKind: string | undefined): Metric.Metric.AttributeSet =>
  triggerKind ? { trigger_kind: triggerKind } : {};

/**
 * Build an {@link ExecutionObserver} that drives the global Effect Metric
 * registry from the execution lifecycle stream. Counters track executions and
 * tool calls (started / completed / failed); a histogram records execution
 * duration tagged by `trigger_kind`. Start timestamps are buffered per
 * execution so {@link ExecutionFinished} can compute the elapsed duration.
 */
export const createExecutionMetricsObserver = (): ExecutionObserver => {
  const executionStarts = new Map<
    ExecutionId,
    { readonly startedAt: Date; readonly trigger?: string }
  >();

  const updateCounter = (
    counter: Metric.Counter<number>,
    attributes: Metric.Metric.AttributeSet = {},
  ): Effect.Effect<void> => Metric.update(Metric.withAttributes(counter, attributes), 1);

  const handleExecutionStarted = (
    event: Extract<ExecutionEvent, { readonly _tag: "ExecutionStarted" }>,
  ) =>
    Effect.sync(() => {
      executionStarts.set(event.executionId, {
        startedAt: event.startedAt,
        trigger: event.trigger?.kind,
      });
    }).pipe(
      Effect.andThen(updateCounter(executionsStarted, triggerAttributes(event.trigger?.kind))),
    );

  const handleExecutionFinished = (
    event: Extract<ExecutionEvent, { readonly _tag: "ExecutionFinished" }>,
  ) =>
    Effect.gen(function* () {
      const started = executionStarts.get(event.executionId);
      if (started) {
        executionStarts.delete(event.executionId);
        const durationMs = Math.max(0, event.completedAt.getTime() - started.startedAt.getTime());
        yield* Metric.update(
          Metric.withAttributes(executionDuration, triggerAttributes(started.trigger)),
          durationMs,
        );
      }

      const attributes = triggerAttributes(started?.trigger);
      return yield* event.status === "completed"
        ? updateCounter(executionsCompleted, attributes)
        : updateCounter(executionsFailed, attributes);
    });

  return {
    handle: (event) => {
      if (Predicate.isTagged(event, "ExecutionStarted")) {
        return handleExecutionStarted(event);
      }
      if (Predicate.isTagged(event, "ExecutionFinished")) {
        return handleExecutionFinished(event);
      }
      if (Predicate.isTagged(event, "ToolCallStarted")) {
        return updateCounter(toolCallsStarted);
      }
      if (Predicate.isTagged(event, "ToolCallFinished")) {
        return event.status === "completed"
          ? updateCounter(toolCallsCompleted)
          : updateCounter(toolCallsFailed);
      }
      return Effect.void;
    },
  };
};
