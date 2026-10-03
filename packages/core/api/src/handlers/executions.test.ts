import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { createExecutionEngine } from "@executor-js/execution";
import { createExecutor, definePlugin, tool, ToolResult } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";

import { ExecutorApi } from "../api";
import { CoreHandlers } from "./index";
import { observabilityMiddleware } from "../observability";
import { ExecutionEngineService, ExecutorService } from "../services";

const CompletedResponse = Schema.Struct({
  status: Schema.Literal("completed"),
  toolCalls: Schema.Array(
    Schema.Struct({ path: Schema.String, isError: Schema.Boolean, durationMs: Schema.Number }),
  ),
});

const PausedResponse = Schema.Struct({
  status: Schema.Literal("paused"),
  structured: Schema.Struct({ executionId: Schema.String }),
});

const auditPlugin = definePlugin(() => ({
  id: "execution-audit-test" as const,
  storage: () => ({}),
  staticIntegrations: () => [
    {
      id: "audit.main",
      kind: "in-memory" as const,
      name: "Audit tools",
      tools: [
        tool({
          name: "success",
          description: "Return a successful result.",
          execute: () => Effect.succeed({ ok: true }),
        }),
        tool({
          name: "failure",
          description: "Return an unsuccessful result.",
          execute: () =>
            Effect.succeed(ToolResult.fail({ code: "audit_failure", message: "Call failed." })),
        }),
        tool({
          name: "approval",
          description: "Require approval before returning a successful result.",
          annotations: { requiresApproval: true },
          execute: () => Effect.succeed({ ok: true }),
        }),
      ],
    },
  ],
}));

const makeHarness = () =>
  Effect.gen(function* () {
    const executor = yield* createExecutor(makeTestConfig({ plugins: [auditPlugin()] }));
    const engine = createExecutionEngine({
      executor,
      codeExecutor: {
        execute: (code, invoker) =>
          Effect.gen(function* () {
            if (code === "empty") return { result: "ok", logs: [] };
            if (code === "approval") {
              const result = yield* invoker.invoke({ path: "audit.main.approval", args: {} });
              return { result, logs: [] };
            }
            yield* invoker.invoke({ path: "audit.main.success", args: {} });
            const result = yield* invoker.invoke({ path: "audit.main.failure", args: {} });
            return { result, logs: [] };
          }).pipe(Effect.orDie),
      },
    });
    yield* Effect.addFinalizer(() =>
      engine.shutdown.pipe(Effect.andThen(executor.close()), Effect.ignore),
    );
    const web = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(ExecutorApi).pipe(
            Layer.provide(CoreHandlers),
            Layer.provide(observabilityMiddleware(ExecutorApi)),
            Layer.provide(Layer.succeed(ExecutorService)(executor)),
            Layer.provide(Layer.succeed(ExecutionEngineService)(engine)),
            Layer.provideMerge(HttpServer.layerServices),
          ),
          { disableLogger: true },
        ),
      ),
      (handler) => Effect.promise(() => handler.dispose()),
    );
    const context = Context.make(ExecutorService, executor).pipe(
      Context.add(ExecutionEngineService, engine),
    );
    const post = (path: string, payload: unknown) =>
      Effect.promise(() =>
        web.handler(
          new Request(`http://localhost${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          }),
          context,
        ),
      );
    return { executor, post };
  });

const completedBody = (response: Response) =>
  Effect.promise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CompletedResponse)),
  );

describe("executions HTTP tool-call audit", () => {
  it.effect("completed execution includes successful and failing tool calls in call order", () =>
    Effect.gen(function* () {
      const { post } = yield* makeHarness();
      const response = yield* post("/executions", { code: "calls" });
      expect(response.status).toBe(200);
      const body = yield* completedBody(response);
      expect(body.toolCalls).toEqual([
        { path: "audit.main.success", isError: false, durationMs: expect.any(Number) },
        { path: "audit.main.failure", isError: true, durationMs: expect.any(Number) },
      ]);
      expect(body.toolCalls.every((call) => call.durationMs >= 0)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("completed execution with no tool calls includes an empty audit", () =>
    Effect.gen(function* () {
      const { post } = yield* makeHarness();
      const response = yield* post("/executions", { code: "empty" });
      expect(response.status).toBe(200);
      expect((yield* completedBody(response)).toolCalls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("paused execution omits the audit and completed resume includes it", () =>
    Effect.gen(function* () {
      const { post } = yield* makeHarness();
      const response = yield* post("/executions", { code: "approval" });
      expect(response.status).toBe(200);
      const rawBody: unknown = yield* Effect.promise(() => response.json());
      expect(rawBody).not.toHaveProperty("toolCalls");
      const paused = yield* Schema.decodeUnknownEffect(PausedResponse)(rawBody);
      const resumed = yield* post(`/executions/${paused.structured.executionId}/resume`, {
        action: "accept",
      });
      expect(resumed.status).toBe(200);
      expect((yield* completedBody(resumed)).toolCalls).toEqual([
        { path: "audit.main.approval", isError: false, durationMs: expect.any(Number) },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("accepted pending approval includes the re-run's tool calls", () =>
    Effect.gen(function* () {
      const { executor, post } = yield* makeHarness();
      yield* executor.pendingApprovals.put({
        executionId: "pending-accepted",
        artifactId: "artifact",
        address: "audit.main.approval",
        code: "approval",
        expiresAt: Date.now() + 60_000,
      });
      const response = yield* post("/executions/pending-accepted/resume", { action: "accept" });
      expect(response.status).toBe(200);
      expect((yield* completedBody(response)).toolCalls).toEqual([
        { path: "audit.main.approval", isError: false, durationMs: expect.any(Number) },
      ]);
    }).pipe(Effect.scoped),
  );

  for (const action of ["decline", "cancel"] as const) {
    it.effect(`${action} pending approval includes an empty audit`, () =>
      Effect.gen(function* () {
        const { executor, post } = yield* makeHarness();
        yield* executor.pendingApprovals.put({
          executionId: `pending-${action}`,
          artifactId: "artifact",
          address: "audit.main.approval",
          code: "approval",
          expiresAt: Date.now() + 60_000,
        });
        const response = yield* post(`/executions/pending-${action}/resume`, { action });
        expect(response.status).toBe(200);
        expect((yield* completedBody(response)).toolCalls).toEqual([]);
      }).pipe(Effect.scoped),
    );
  }
});
