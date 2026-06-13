// ---------------------------------------------------------------------------
// Handler-level integration test for the execution-history HTTP group.
//
// Drives the three read endpoints end-to-end through the HttpApi layer: the
// handlers pull the read surface from the extension service, map query/path
// params onto the store options, and the wire schemas encode the row shapes. A
// stub extension stands in for the store so the test exercises the HTTP edge +
// handler wiring (param parsing, CSV split, time-range build) rather than a
// live server.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { addGroup, observabilityMiddleware } from "@executor-js/api";
import { CoreHandlers, ExecutionEngineService, ExecutorService } from "@executor-js/api/server";

import type { RunRow, ToolCallRow } from "../sdk/collections";
import type {
  ExecutionHistoryDetail,
  ExecutionHistoryListOptions,
  ExecutionHistoryListResult,
} from "../sdk/store";
import { ExecutionHistoryGroup } from "./group";
import {
  ExecutionHistoryExtensionService,
  ExecutionHistoryHandlers,
  type ExecutionHistoryExtension,
} from "./handlers";

const Api = addGroup(ExecutionHistoryGroup);
const UnusedExecutor = Layer.succeed(ExecutorService)({} as ExecutorService["Service"]);
const UnusedExecutionEngine = Layer.succeed(ExecutionEngineService)(
  {} as ExecutionEngineService["Service"],
);

const runRow = (overrides: Partial<RunRow>): RunRow => ({
  executionId: "exec_1",
  status: "completed",
  code: "noop",
  resultJson: null,
  errorText: null,
  logsJson: null,
  triggerKind: "manual",
  triggerMetaJson: null,
  startedAt: 1000,
  completedAt: 2000,
  durationMs: 1000,
  toolCallCount: 1,
  hadInteraction: false,
  ...overrides,
});

const toolCallRow = (overrides: Partial<ToolCallRow>): ToolCallRow => ({
  executionId: "exec_1",
  toolCallId: "call_1",
  status: "completed",
  path: "tools.shell.run",
  namespace: "tools",
  argsJson: null,
  resultJson: null,
  errorText: null,
  startedAt: 1000,
  completedAt: 1500,
  durationMs: 500,
  ...overrides,
});

// Records the options the handler maps so the test can assert query parsing.
const makeStubExtension = (captured: {
  options?: ExecutionHistoryListOptions;
}): ExecutionHistoryExtension => ({
  list: (options): Effect.Effect<ExecutionHistoryListResult> => {
    captured.options = options;
    return Effect.succeed({ runs: [runRow({})], total: 1 });
  },
  get: (executionId): Effect.Effect<ExecutionHistoryDetail | null> =>
    Effect.succeed(
      executionId === "exec_1"
        ? { run: runRow({}), toolCalls: [toolCallRow({})], interactions: [] }
        : null,
    ),
  listToolCalls: (): Effect.Effect<readonly ToolCallRow[]> => Effect.succeed([toolCallRow({})]),
});

const webHandlerFor = (extension: ExecutionHistoryExtension) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(Api).pipe(
          Layer.provide(CoreHandlers),
          Layer.provide(ExecutionHistoryHandlers),
          Layer.provide(observabilityMiddleware(Api)),
          Layer.provide(UnusedExecutor),
          Layer.provide(UnusedExecutionEngine),
          Layer.provide(Layer.succeed(ExecutionHistoryExtensionService, extension)),
          Layer.provideMerge(HttpServer.layerServices),
          Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
        ),
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  );

const get = (
  web: { handler: (request: Request, ...rest: never[]) => Promise<Response> },
  url: string,
) =>
  Effect.promise(() =>
    (web.handler as (request: Request) => Promise<Response>)(new Request(url, { method: "GET" })),
  );

describe("ExecutionHistoryHandlers", () => {
  it.effect("list maps CSV/number/boolean query params onto the store options", () =>
    Effect.gen(function* () {
      const captured: { options?: ExecutionHistoryListOptions } = {};
      const web = yield* webHandlerFor(makeStubExtension(captured));

      const res = yield* get(
        web,
        "http://localhost/execution-history/runs?status=completed,failed&trigger=manual&from=100&to=900&interaction=true&limit=10&offset=5&sort=asc",
      );
      expect(res.status).toBe(200);
      const body = (yield* Effect.promise(() => res.json())) as {
        runs: { executionId: string }[];
        total: number;
      };
      expect(body.total).toBe(1);
      expect(body.runs.map((r) => r.executionId)).toEqual(["exec_1"]);

      const options = captured.options;
      expect(options).toBeDefined();
      expect(options?.statusFilter).toEqual(["completed", "failed"]);
      expect(options?.triggerFilter).toEqual(["manual"]);
      expect(options?.timeRange).toEqual({ from: 100, to: 900 });
      expect(options?.hadInteraction).toBe(true);
      expect(options?.limit).toBe(10);
      expect(options?.offset).toBe(5);
      expect(options?.sort).toBe("asc");
    }),
  );

  it.effect("list omits filters when no query params are supplied", () =>
    Effect.gen(function* () {
      const captured: { options?: ExecutionHistoryListOptions } = {};
      const web = yield* webHandlerFor(makeStubExtension(captured));

      const res = yield* get(web, "http://localhost/execution-history/runs");
      expect(res.status).toBe(200);
      yield* Effect.promise(() => res.json());

      const options = captured.options;
      expect(options?.statusFilter).toBeUndefined();
      expect(options?.triggerFilter).toBeUndefined();
      expect(options?.timeRange).toBeUndefined();
      expect(options?.hadInteraction).toBeUndefined();
    }),
  );

  it.effect("get returns the run detail and null for an unknown id", () =>
    Effect.gen(function* () {
      const web = yield* webHandlerFor(makeStubExtension({}));

      const hit = yield* get(web, "http://localhost/execution-history/runs/exec_1");
      expect(hit.status).toBe(200);
      const hitBody = (yield* Effect.promise(() => hit.json())) as {
        run: { executionId: string };
        toolCalls: unknown[];
        interactions: unknown[];
      };
      expect(hitBody.run.executionId).toBe("exec_1");
      expect(hitBody.toolCalls).toHaveLength(1);

      const miss = yield* get(web, "http://localhost/execution-history/runs/nope");
      expect(miss.status).toBe(200);
      const missBody = yield* Effect.promise(() => miss.json());
      expect(missBody).toBeNull();
    }),
  );

  it.effect("listToolCalls returns the run's tool calls", () =>
    Effect.gen(function* () {
      const web = yield* webHandlerFor(makeStubExtension({}));

      const res = yield* get(web, "http://localhost/execution-history/runs/exec_1/tool-calls");
      expect(res.status).toBe(200);
      const body = (yield* Effect.promise(() => res.json())) as {
        toolCalls: { toolCallId: string }[];
      };
      expect(body.toolCalls.map((c) => c.toolCallId)).toEqual(["call_1"]);
    }),
  );
});
