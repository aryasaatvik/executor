import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  ExecutionFinished,
  ExecutionId,
  ExecutionStarted,
  ExecutionToolCallId,
  Subject,
  Tenant,
  ToolCallFinished,
  ToolCallStarted,
} from "@executor-js/sdk/core";

import { createExecutionMetricsObserver } from "../sdk/observer";
import { renderPrometheus } from "./prometheus";

const owner = { tenant: Tenant.make("tenant_test"), subject: Subject.make("subject_test") };

const executionId = ExecutionId.make("exec_metrics_test");
const toolCallId = ExecutionToolCallId.make("toolcall_metrics_test");

const startedAt = new Date("2026-06-13T00:00:00.000Z");
const completedAt = new Date("2026-06-13T00:00:00.250Z");

describe("execution-metrics observer + renderPrometheus", () => {
  it.effect("records counters/histogram a Prometheus scrape can expose", () =>
    Effect.gen(function* () {
      const observer = createExecutionMetricsObserver();

      yield* observer.handle(
        new ExecutionStarted({
          executionId,
          owner,
          code: "console.log('hi')",
          trigger: { kind: "manual" },
          startedAt,
        }),
      );
      yield* observer.handle(
        new ToolCallStarted({
          executionId,
          toolCallId,
          owner,
          path: "github.issues.create",
          args: {},
          startedAt,
        }),
      );
      yield* observer.handle(
        new ToolCallFinished({
          executionId,
          toolCallId,
          owner,
          path: "github.issues.create",
          status: "completed",
          completedAt,
        }),
      );
      yield* observer.handle(
        new ExecutionFinished({
          executionId,
          owner,
          status: "completed",
          result: "ok",
          completedAt,
        }),
      );

      const text = yield* renderPrometheus;

      // Counter + histogram series names are exposed.
      expect(text).toContain("# TYPE executor_execution_started_total counter");
      expect(text).toContain("# TYPE executor_execution_completed_total counter");
      expect(text).toContain("# TYPE executor_tool_call_started_total counter");
      expect(text).toContain("# TYPE executor_tool_call_completed_total counter");
      expect(text).toContain("# TYPE executor_execution_duration_ms histogram");
      expect(text).toContain("executor_execution_duration_ms_bucket");
      expect(text).toContain('le="+Inf"');

      // Effect's histogram buckets already carry the terminal `+Inf` boundary,
      // so the renderer must emit it exactly once per series — a duplicate
      // `+Inf` bucket line is a duplicate label set and a scrape rejects it.
      const infBuckets = text
        .split("\n")
        .filter(
          (line) =>
            line.startsWith("executor_execution_duration_ms_bucket{") && line.includes('le="+Inf"'),
        );
      expect(infBuckets).toHaveLength(1);

      // The trigger_kind attribute rides the tagged series.
      expect(text).toContain('trigger_kind="manual"');

      // At least one started execution was counted (global registry — value ≥ 1).
      const startedLine = text
        .split("\n")
        .find(
          (line) =>
            line.startsWith("executor_execution_started_total{") &&
            line.includes('trigger_kind="manual"'),
        );
      const startedValue = startedLine
        ? Number(startedLine.slice(startedLine.lastIndexOf(" ") + 1))
        : 0;
      expect(startedValue).toBeGreaterThanOrEqual(1);
    }),
  );
});
