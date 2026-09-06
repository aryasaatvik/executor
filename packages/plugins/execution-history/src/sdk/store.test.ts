import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  ExecutionFinished,
  ExecutionId,
  ExecutionInteractionId,
  ExecutionStarted,
  ExecutionToolCallId,
  FormElicitation,
  InteractionStarted,
  Subject,
  Tenant,
  ToolAddress,
  ToolCallFinished,
  ToolCallStarted,
  createExecutor,
} from "@executor-js/sdk";
import { makeTestConfig, makeTestExecutor } from "@executor-js/sdk/testing";

import { executionHistoryPlugin } from "./plugin";
import { DEFAULT_STALE_RUNNING_AFTER_MS } from "./store";

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

      const listed = yield* executor.executionHistory.list({ limit: 50 });
      expect(listed.meta?.totalRowCount).toBe(1);
      expect(listed.meta?.filterRowCount).toBe(1);
      expect(listed.meta?.statusCounts).toContainEqual({ status: "completed", count: 1 });
      expect(listed.nextCursor).toBeNull();
      const run = listed.runs[0];
      expect(run?.executionId).toBe("exec_1");
      expect(run?.status).toBe("completed");
      expect(run?.toolCallCount).toBe(1);
      expect(run?.durationMs).toBe(2000);
      expect(run?.hadInteraction).toBe(false);
      expect(run?.hadFormApproval).toBe(false);
      expect(run?.hadUrlApproval).toBe(false);
      // codePreview + trigger from ExecutionStarted survive the terminal re-write.
      expect(run?.codePreview).toBe("await tools.shell({ command: 'ls' })");
      expect(run?.triggerKind).toBe("manual");

      const detail = yield* executor.executionHistory.get("exec_1");
      expect(detail?.run.status).toBe("completed");
      // Full code + the tool call now come from the R2 detail object.
      expect(detail?.code).toBe("await tools.shell({ command: 'ls' })");
      expect(detail?.toolCalls).toHaveLength(1);
      expect(detail?.toolCalls[0]?.toolCallId).toBe("call_1");
      expect(detail?.toolCalls[0]?.status).toBe("completed");
      expect(detail?.toolCalls[0]?.durationMs).toBe(1000);
      expect(detail?.toolCalls[0]?.path).toBe("tools.shell.org.default.run");
      expect(detail?.interactions).toHaveLength(0);
    }),
  );

  it.effect("persists emitted output, an interrupted status, and failed tool calls", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        backend: "sqlite",
        plugins: [executionHistoryPlugin()] as const,
      });
      const startedAt = new Date();
      const later = new Date(startedAt.getTime() + 500);

      // Emit-only completed run with a failed tool call (ToolResult envelope).
      const emitId = ExecutionId.make("exec_emit");
      const callId = ExecutionToolCallId.make("call_fail");
      yield* executor.executionHistory.handleEvent(
        new ExecutionStarted({ executionId: emitId, owner, code: "emit(1)", startedAt }),
      );
      yield* executor.executionHistory.handleEvent(
        new ToolCallStarted({
          executionId: emitId,
          toolCallId: callId,
          owner,
          path: "github_api.repos.get",
          args: { owner: "x" },
          startedAt,
        }),
      );
      const envelope = { ok: false, error: { code: "tool_not_found", message: "Tool not found" } };
      yield* executor.executionHistory.handleEvent(
        new ToolCallFinished({
          executionId: emitId,
          toolCallId: callId,
          owner,
          path: "github_api.repos.get",
          status: "failed",
          result: envelope,
          error: "tool_not_found: Tool not found",
          completedAt: later,
        }),
      );
      yield* executor.executionHistory.handleEvent(
        new ExecutionFinished({
          executionId: emitId,
          owner,
          status: "completed",
          result: null,
          output: [
            { type: "content", content: { a: 1 } },
            { type: "content", content: "plain" },
          ],
          logs: ["[error] boom"],
          completedAt: later,
        }),
      );

      // Interrupted run: no result, no logs, an interruption cause as error.
      const intId = ExecutionId.make("exec_int");
      yield* executor.executionHistory.handleEvent(
        new ExecutionStarted({ executionId: intId, owner, code: "while(true){}", startedAt }),
      );
      yield* executor.executionHistory.handleEvent(
        new ExecutionFinished({
          executionId: intId,
          owner,
          status: "interrupted",
          error: "All fibers interrupted without errors.",
          completedAt: later,
        }),
      );

      const emitDetail = yield* executor.executionHistory.get("exec_emit");
      expect(emitDetail?.run.status).toBe("completed");
      expect(emitDetail?.run.logErrorCount).toBe(1);
      expect(emitDetail?.resultJson).toBe("null");
      expect(emitDetail?.outputJson).toBe(
        JSON.stringify([
          { type: "content", content: { a: 1 } },
          { type: "content", content: "plain" },
        ]),
      );
      expect(emitDetail?.toolCalls[0]?.status).toBe("failed");
      expect(emitDetail?.toolCalls[0]?.errorText).toBe("tool_not_found: Tool not found");
      expect(emitDetail?.toolCalls[0]?.resultJson).toBe(JSON.stringify(envelope));

      const intDetail = yield* executor.executionHistory.get("exec_int");
      expect(intDetail?.run.status).toBe("interrupted");
      expect(intDetail?.run.durationMs).toBe(500);
      expect(intDetail?.outputJson).toBeNull();
      expect(intDetail?.errorText).toMatch(/interrupted/);

      const listed = yield* executor.executionHistory.list({
        statusFilter: ["interrupted"],
        limit: 10,
      });
      expect(listed.runs.map((run) => run.executionId)).toEqual(["exec_int"]);
      expect(listed.meta?.statusCounts).toContainEqual({ status: "interrupted", count: 1 });
    }),
  );

  // `it.live`: the sweep reads the Effect Clock, which `it.effect` pins to 0.
  it.live("sweeps abandoned running rows as interrupted when a new run starts", () =>
    Effect.gen(function* () {
      const dataDir = mkdtempSync(join(tmpdir(), "execution-history-sweep-"));
      const executor = yield* createExecutor(
        makeTestConfig({
          backend: "sqlite",
          dataDir,
          plugins: [executionHistoryPlugin()] as const,
        }),
      );
      const now = Date.now();
      const staleStart = new Date(now - DEFAULT_STALE_RUNNING_AFTER_MS - 60_000);
      const freshStart = new Date(now - 1_000);

      // One abandoned run (its buffer is gone, as after a host restart), one
      // old-but-live run whose buffer is still in this process, one live run
      // started recently, and one waiting run older than the cutoff. Only the
      // first may be swept.
      // A second executor over the SAME on-disk database plays the previous
      // process: it recorded the run's start and then died, so the store under
      // test holds no buffer for it.
      const previousProcess = yield* createExecutor(
        makeTestConfig({
          backend: "sqlite",
          dataDir,
          plugins: [executionHistoryPlugin()] as const,
        }),
      );
      yield* previousProcess.executionHistory.handleEvent(
        new ExecutionStarted({
          executionId: ExecutionId.make("exec_stale"),
          owner,
          code: "sleep forever",
          startedAt: staleStart,
        }),
      );
      expect((yield* executor.executionHistory.get("exec_stale"))?.run.status).toBe("running");
      yield* executor.executionHistory.handleEvent(
        new ExecutionStarted({
          executionId: ExecutionId.make("exec_old_live"),
          owner,
          code: "long but alive",
          startedAt: staleStart,
        }),
      );
      yield* executor.executionHistory.handleEvent(
        new ExecutionStarted({
          executionId: ExecutionId.make("exec_live"),
          owner,
          code: "still going",
          startedAt: freshStart,
        }),
      );
      const waitingId = ExecutionId.make("exec_waiting");
      yield* executor.executionHistory.handleEvent(
        new ExecutionStarted({
          executionId: waitingId,
          owner,
          code: "approve?",
          startedAt: staleStart,
        }),
      );
      yield* executor.executionHistory.handleEvent(
        new InteractionStarted({
          executionId: waitingId,
          interactionId: ExecutionInteractionId.make("ix_1"),
          owner,
          context: {
            address: ToolAddress.make("tools.policies.org.default.requireApproval"),
            args: {},
            request: FormElicitation.make({ message: "Approve?", requestedSchema: {} }),
          },
          startedAt: staleStart,
        }),
      );

      // The next ExecutionStarted triggers the sweep.
      yield* executor.executionHistory.handleEvent(
        new ExecutionStarted({
          executionId: ExecutionId.make("exec_trigger"),
          owner,
          code: "noop",
          startedAt: new Date(now),
        }),
      );

      const byId = new Map(
        (yield* executor.executionHistory.list({ limit: 10 })).runs.map((run) => [
          run.executionId,
          run,
        ]),
      );
      expect(byId.get("exec_stale")?.status).toBe("interrupted");
      expect(byId.get("exec_stale")?.completedAt).not.toBeNull();
      expect(byId.get("exec_live")?.status).toBe("running");
      expect(byId.get("exec_waiting")?.status).toBe("waiting_for_interaction");
      expect(byId.get("exec_trigger")?.status).toBe("running");

      const staleDetail = yield* executor.executionHistory.get("exec_stale");
      expect(staleDetail?.code).toBe("sleep forever");
      expect(staleDetail?.errorText).toMatch(/never reported completion/);

      // A late finish for the swept run still lands (buffer-lost path) and wins.
      yield* executor.executionHistory.handleEvent(
        new ExecutionFinished({
          executionId: ExecutionId.make("exec_stale"),
          owner,
          status: "completed",
          result: 1,
          completedAt: new Date(now),
        }),
      );
      expect((yield* executor.executionHistory.get("exec_stale"))?.run.status).toBe("completed");
    }),
  );

  it.effect("indexes approval kind for list filtering and facets", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        backend: "sqlite",
        plugins: [executionHistoryPlugin()] as const,
      });

      const executionId = ExecutionId.make("exec_form");
      const interactionId = ExecutionInteractionId.make("approval_1");
      const startedAt = new Date("2026-05-29T10:00:00.000Z");
      const approvalAt = new Date("2026-05-29T10:00:01.000Z");
      const completedAt = new Date("2026-05-29T10:00:02.000Z");

      yield* executor.executionHistory.handleEvent(
        new ExecutionStarted({
          executionId,
          owner,
          code: "await tools.policy.requireApproval({ reason: 'deploy' })",
          trigger: { kind: "manual" },
          startedAt,
        }),
      );
      yield* executor.executionHistory.handleEvent(
        new InteractionStarted({
          executionId,
          interactionId,
          owner,
          context: {
            address: ToolAddress.make("tools.policies.org.default.requireApproval"),
            args: { reason: "deploy" },
            request: FormElicitation.make({ message: "Approve deploy?", requestedSchema: {} }),
          },
          startedAt: approvalAt,
        }),
      );
      yield* executor.executionHistory.handleEvent(
        new ExecutionFinished({
          executionId,
          owner,
          status: "completed",
          result: { ok: true },
          logs: [],
          completedAt,
        }),
      );

      const listed = yield* executor.executionHistory.list({
        approvalType: "form",
        limit: 50,
      });
      expect(listed.runs.map((run) => run.executionId)).toEqual(["exec_form"]);
      expect(listed.runs[0]?.hadInteraction).toBe(true);
      expect(listed.runs[0]?.hadFormApproval).toBe(true);
      expect(listed.runs[0]?.hadUrlApproval).toBe(false);
      expect(listed.meta?.interactionCounts).toMatchObject({
        withInteraction: 1,
        withoutInteraction: 0,
        formApproval: 1,
        urlApproval: 0,
      });

      const detail = yield* executor.executionHistory.get("exec_form");
      expect(detail?.interactions[0]?.kind).toBe("FormElicitation");
    }),
  );
});
