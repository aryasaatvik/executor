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
} from "@executor-js/sdk";
import { makeTestExecutor } from "@executor-js/sdk/testing";

import { executionHistoryPlugin } from "./plugin";

const owner = { tenant: Tenant.make("tenant_test"), subject: Subject.make("subject_test") };

describe("execution-history store", () => {
  it.effect("records a completed run with one tool call from the event stream", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        backend: "sqlite",
        plugins: [executionHistoryPlugin()] as const,
      });

      const executionId = ExecutionId.make("exec_1");
      const toolCallId = ExecutionToolCallId.make("call_1");
      const startedAt = new Date("2026-05-29T10:00:00.000Z");
      const toolFinishedAt = new Date("2026-05-29T10:00:01.000Z");
      const completedAt = new Date("2026-05-29T10:00:02.000Z");

      yield* executor.executionHistory.handleEvent(
        new ExecutionStarted({
          executionId,
          owner,
          code: "await tools.shell({ command: 'ls' })",
          trigger: { kind: "manual" },
          startedAt,
        }),
      );
      yield* executor.executionHistory.handleEvent(
        new ToolCallStarted({
          executionId,
          toolCallId,
          owner,
          path: "tools.shell.org.default.run",
          args: { command: "ls" },
          startedAt,
        }),
      );
      yield* executor.executionHistory.handleEvent(
        new ToolCallFinished({
          executionId,
          toolCallId,
          owner,
          path: "tools.shell.org.default.run",
          status: "completed",
          result: { stdout: "a.txt" },
          completedAt: toolFinishedAt,
        }),
      );
      yield* executor.executionHistory.handleEvent(
        new ExecutionFinished({
          executionId,
          owner,
          status: "completed",
          result: { ok: true },
          logs: ["ran ls"],
          completedAt,
        }),
      );

      const listed = yield* executor.executionHistory.list();
      expect(listed.total).toBe(1);
      const run = listed.runs[0];
      expect(run?.executionId).toBe("exec_1");
      expect(run?.status).toBe("completed");
      expect(run?.toolCallCount).toBe(1);
      expect(run?.durationMs).toBe(2000);
      expect(run?.hadInteraction).toBe(false);
      // code + trigger from ExecutionStarted survive the terminal re-write.
      expect(run?.code).toBe("await tools.shell({ command: 'ls' })");
      expect(run?.triggerKind).toBe("manual");

      const detail = yield* executor.executionHistory.get("exec_1");
      expect(detail?.run.status).toBe("completed");
      expect(detail?.toolCalls).toHaveLength(1);
      expect(detail?.toolCalls[0]?.toolCallId).toBe("call_1");
      expect(detail?.toolCalls[0]?.status).toBe("completed");
      expect(detail?.toolCalls[0]?.durationMs).toBe(1000);
      expect(detail?.interactions).toHaveLength(0);

      const toolCallRows = yield* executor.executionHistory.listToolCalls("exec_1");
      expect(toolCallRows).toHaveLength(1);
      expect(toolCallRows[0]?.path).toBe("tools.shell.org.default.run");
    }),
  );
});
