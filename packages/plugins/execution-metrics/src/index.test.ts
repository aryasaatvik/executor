import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  ExecutionFinished,
  ExecutionId,
  ExecutionStarted,
  ExecutionToolCallId,
  ScopeId,
  ToolCallFinished,
  ToolCallStarted,
} from "@executor-js/sdk/core";
import { renderPrometheus } from "@executor-js/api";

import { createExecutionMetricsObserver } from "./index";

const scopeId = ScopeId.make("scope-main");

describe("createExecutionMetricsObserver", () => {
  it.effect("updates execution and tool call metrics from observer events", () =>
    Effect.gen(function* () {
      const observer = createExecutionMetricsObserver();
      const executionId = ExecutionId.make(`metrics-${Math.random().toString(36).slice(2)}`);
      const toolCallId = ExecutionToolCallId.make(`${executionId}-tool`);

      yield* observer.handle(
        new ExecutionStarted({
          executionId,
          scopeId,
          code: "return 1",
          trigger: { kind: "manual" },
          startedAt: new Date(1_000),
        }),
      );
      yield* observer.handle(
        new ToolCallStarted({
          executionId,
          toolCallId,
          scopeId,
          path: "executor.openapi.addSource",
          args: {},
          startedAt: new Date(1_100),
        }),
      );
      yield* observer.handle(
        new ToolCallFinished({
          executionId,
          toolCallId,
          scopeId,
          path: "executor.openapi.addSource",
          status: "failed",
          error: "boom",
          completedAt: new Date(1_200),
        }),
      );
      yield* observer.handle(
        new ExecutionFinished({
          executionId,
          scopeId,
          status: "failed",
          error: "boom",
          completedAt: new Date(1_250),
        }),
      );

      const output = yield* renderPrometheus;
      expect(output).toMatch(/^executor_execution_started_total{trigger_kind="manual"} 1$/m);
      expect(output).toMatch(/^executor_execution_failed_total{trigger_kind="manual"} 1$/m);
      expect(output).toMatch(/^executor_tool_call_started_total 1$/m);
      expect(output).toMatch(/^executor_tool_call_failed_total 1$/m);
      expect(output).toMatch(/^executor_execution_duration_ms_count{trigger_kind="manual"} 1$/m);
      expect(output).toMatch(/^executor_execution_duration_ms_sum{trigger_kind="manual"} 250$/m);
    }),
  );
});
