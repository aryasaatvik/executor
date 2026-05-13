import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  ExecutionFinished,
  ExecutionId,
  ExecutionStarted,
  Scope,
  ScopeId,
  ToolCallFinished,
  ToolCallStarted,
  ExecutionToolCallId,
  collectSchemas,
  composeExecutionObservers,
  createExecutor,
  makeInMemoryBlobStore,
} from "@executor-js/sdk/core";
import { makeMemoryAdapter } from "@executor-js/storage-core/testing/memory";

import { executionHistoryPlugin } from "./plugin";

const build = () =>
  Effect.gen(function* () {
    const plugins = [executionHistoryPlugin()] as const;
    const adapter = makeMemoryAdapter({ schema: collectSchemas(plugins) });
    const executor = yield* createExecutor({
      scopes: [
        Scope.make({
          id: ScopeId.make("scope_test"),
          name: "Test Scope",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        }),
      ],
      adapter,
      blobs: makeInMemoryBlobStore(),
      plugins,
      onElicitation: "accept-all",
    });
    const observer = composeExecutionObservers(plugins, executor);
    return { executor, observer };
  });

describe("executionHistoryPlugin", () => {
  it.effect("records execution and tool-call lifecycle events through the observer", () =>
    Effect.gen(function* () {
      const { executor, observer } = yield* build();
      const executionId = ExecutionId.make("exec_test");
      const toolCallId = ExecutionToolCallId.make("tool_call_test");
      const scopeId = ScopeId.make("scope_test");
      const startedAt = new Date("2026-01-01T00:00:00.000Z");
      const toolStartedAt = new Date("2026-01-01T00:00:01.000Z");
      const completedAt = new Date("2026-01-01T00:00:03.000Z");

      yield* observer.handle(
        new ExecutionStarted({
          executionId,
          scopeId,
          code: "return await tools.github.issue.get({ id: 1 })",
          trigger: { kind: "http", metadata: { route: "/executions" } },
          startedAt,
        }),
      );
      yield* observer.handle(
        new ToolCallStarted({
          executionId,
          toolCallId,
          scopeId,
          path: "github.issue.get",
          args: { id: 1 },
          startedAt: toolStartedAt,
        }),
      );
      yield* observer.handle(
        new ToolCallFinished({
          executionId,
          toolCallId,
          scopeId,
          path: "github.issue.get",
          status: "completed",
          result: { title: "Fix" },
          completedAt,
        }),
      );
      yield* observer.handle(
        new ExecutionFinished({
          executionId,
          scopeId,
          status: "completed",
          result: { ok: true },
          logs: ["done"],
          completedAt,
        }),
      );

      const detail = yield* executor.executionHistory.get(executionId);
      expect(detail?.execution.status).toBe("completed");
      expect(detail?.execution.toolCallCount).toBe(1);
      expect(detail?.execution.triggerKind).toBe("http");

      const toolCalls = yield* executor.executionHistory.listToolCalls(executionId);
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]?.toolPath).toBe("github.issue.get");
      expect(toolCalls[0]?.durationMs).toBe(2000);
    }),
  );

  it.effect("lists with filters and cursor pagination", () =>
    Effect.gen(function* () {
      const { executor, observer } = yield* build();
      const scopeId = ScopeId.make("scope_test");

      for (const id of ["one", "two", "three"]) {
        const executionId = ExecutionId.make(`exec_${id}`);
        yield* observer.handle(
          new ExecutionStarted({
            executionId,
            scopeId,
            code: id === "two" ? "search code" : "plain code",
            trigger: { kind: id === "three" ? "cli" : "http" },
            startedAt: new Date(
              `2026-01-01T00:00:0${id === "one" ? 1 : id === "two" ? 2 : 3}.000Z`,
            ),
          }),
        );
        yield* observer.handle(
          new ExecutionFinished({
            executionId,
            scopeId,
            status: id === "three" ? "failed" : "completed",
            error: id === "three" ? "boom" : undefined,
            completedAt: new Date(
              `2026-01-01T00:00:0${id === "one" ? 2 : id === "two" ? 3 : 4}.000Z`,
            ),
          }),
        );
      }

      const filtered = yield* executor.executionHistory.list({
        scopeId,
        statusFilter: ["completed"],
        triggerFilter: ["http"],
        codeQuery: "search",
        includeMeta: true,
      });
      expect(filtered.executions.map((item) => item.execution.id)).toEqual(["exec_two"]);
      expect(filtered.meta?.filterRowCount).toBe(1);

      const firstPage = yield* executor.executionHistory.list({ scopeId, limit: 2 });
      expect(firstPage.executions).toHaveLength(2);
      expect(firstPage.nextCursor).toBeDefined();
      const secondPage = yield* executor.executionHistory.list({
        scopeId,
        limit: 2,
        cursor: firstPage.nextCursor,
      });
      expect(secondPage.executions.map((item) => item.execution.id)).toEqual(["exec_one"]);
    }),
  );
});
