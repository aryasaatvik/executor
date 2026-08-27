import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

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
  makeInMemoryBlobStore,
  StorageError,
} from "@executor-js/sdk";
import { makeTestConfig, makeTestExecutor } from "@executor-js/sdk/testing";

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

  it.effect("keeps waiting history and interaction detail readable after restart", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        backend: "sqlite",
        plugins: [executionHistoryPlugin()] as const,
      });
      const first = yield* createExecutor(config);

      const executionId = ExecutionId.make("exec_waiting");
      const interactionId = ExecutionInteractionId.make("interaction_1");
      const startedAt = new Date("2026-05-29T10:00:00.000Z");
      const interactionAt = new Date("2026-05-29T10:00:01.000Z");

      yield* first.executionHistory.handleEvent(
        new ExecutionStarted({
          executionId,
          owner,
          code: "await tools.deploy()",
          trigger: { kind: "manual" },
          startedAt,
        }),
      );
      yield* first.executionHistory.handleEvent(
        new InteractionStarted({
          executionId,
          interactionId,
          owner,
          context: {
            address: ToolAddress.make("tools.deploy.org.default.run"),
            args: {},
            request: FormElicitation.make({
              message: "Approve deploy?",
              requestedSchema: {},
            }),
          },
          startedAt: interactionAt,
        }),
      );

      const waiting = yield* first.executionHistory.list();
      expect(waiting.runs[0]?.status).toBe("waiting_for_interaction");
      expect(waiting.runs[0]?.hadInteraction).toBe(true);
      const waitingDetail = yield* first.executionHistory.get("exec_waiting");
      expect(waitingDetail?.interactions[0]).toMatchObject({
        interactionId: "interaction_1",
        status: "pending",
      });
      yield* first.close();

      const restarted = yield* createExecutor(config);
      const detail = yield* restarted.executionHistory.get("exec_waiting");
      expect(detail?.run.status).toBe("waiting_for_interaction");
      expect(detail?.interactions).toHaveLength(1);
      expect(detail?.interactions[0]).toMatchObject({
        interactionId: "interaction_1",
        status: "pending",
        kind: "FormElicitation",
      });
      yield* restarted.close();
      yield* Effect.promise(() => config.testDb.close());
    }),
  );

  it.effect(
    "recovers a terminal publication after retries are exhausted and the store restarts",
    () =>
      Effect.gen(function* () {
        const config = makeTestConfig({
          backend: "sqlite",
          plugins: [executionHistoryPlugin()] as const,
        });
        const baseBlobs = makeInMemoryBlobStore();
        let failRecoveryCleanup = false;
        const blobs = {
          ...baseBlobs,
          delete: (namespace: string, key: string) =>
            failRecoveryCleanup && key === "pending-terminal/exec_recover"
              ? Effect.fail(
                  new StorageError({
                    message: "injected recovery cleanup failure",
                    cause: undefined,
                  }),
                )
              : baseBlobs.delete(namespace, key),
        };
        let failInitialRunWrite = true;
        let failTerminalWrites = false;
        let terminalWriteAttempts = 0;
        const withTerminalWriteFault = (source: typeof config.db): typeof config.db =>
          new Proxy(source, {
            get(target, property, receiver) {
              if (property === "withContext") {
                return (context: unknown) => {
                  const withContext = target.withContext;
                  return withContext === undefined
                    ? target
                    : withTerminalWriteFault(withContext(context));
                };
              }
              if (property === "transaction") {
                const transaction: typeof target.transaction = (run) =>
                  target.transaction((transactionDb) => run(withTerminalWriteFault(transactionDb)));
                return transaction;
              }
              if (property === "create") {
                const create: typeof target.create = (table, input) => {
                  if (failInitialRunWrite && table === "plugin_storage") {
                    // oxlint-disable-next-line executor/no-promise-reject -- boundary: fault-injecting FumaDB Promise adapter must reject so the SDK maps it into StorageFailure
                    return Promise.reject(
                      new StorageError({
                        message: "injected initial run write failure",
                        cause: undefined,
                      }),
                    );
                  }
                  return target.create(table, input);
                };
                return create;
              }
              if (property !== "upsertMany") return Reflect.get(target, property, receiver);
              return (
                table: Parameters<typeof target.upsertMany>[0],
                input: Parameters<typeof target.upsertMany>[1],
              ) => {
                if (failTerminalWrites && table === "plugin_storage") {
                  terminalWriteAttempts += 1;
                  return new Promise<never>((_resolve, reject) =>
                    // oxlint-disable-next-line executor/no-promise-reject -- boundary: fault-injecting FumaDB Promise adapter must reject so the SDK maps it into StorageFailure
                    reject(
                      new StorageError({
                        message: "injected terminal publication failure",
                        cause: undefined,
                      }),
                    ),
                  );
                }
                return target.upsertMany(table, input);
              };
            },
          });
        const db = withTerminalWriteFault(config.db);
        const executorConfig = { ...config, db, blobs };
        const first = yield* createExecutor(executorConfig);

        const executionId = ExecutionId.make("exec_recover");
        const toolCallId = ExecutionToolCallId.make("call_recover");
        const startedAt = new Date("2026-05-29T10:00:00.000Z");
        const initialWrite = yield* Effect.exit(
          first.executionHistory.handleEvent(
            new ExecutionStarted({
              executionId,
              owner,
              code: "await tools.status()",
              trigger: { kind: "manual" },
              startedAt,
            }),
          ),
        );
        expect(Exit.isFailure(initialWrite)).toBe(true);
        failInitialRunWrite = false;
        yield* first.executionHistory.handleEvent(
          new ToolCallStarted({
            executionId,
            toolCallId,
            owner,
            path: "tools.status.org.default.get",
            args: {},
            startedAt,
          }),
        );
        yield* first.executionHistory.handleEvent(
          new ToolCallFinished({
            executionId,
            toolCallId,
            owner,
            path: "tools.status.org.default.get",
            status: "completed",
            result: { ok: true },
            completedAt: new Date("2026-05-29T10:00:01.000Z"),
          }),
        );

        failTerminalWrites = true;
        const failed = yield* Effect.exit(
          first.executionHistory.handleEvent(
            new ExecutionFinished({
              executionId,
              owner,
              status: "completed",
              result: { ok: true },
              completedAt: new Date("2026-05-29T10:00:02.000Z"),
            }),
          ),
        );
        expect(Exit.isFailure(failed)).toBe(true);
        expect(terminalWriteAttempts).toBe(3);
        yield* first.close();

        const restarted = yield* createExecutor(executorConfig);
        const visibleWhileReplayFails = yield* restarted.executionHistory.list();
        expect(visibleWhileReplayFails.total).toBe(1);
        expect(visibleWhileReplayFails.runs[0]?.status).toBe("running");
        const detailWhileReplayFails = yield* restarted.executionHistory.get("exec_recover");
        expect(detailWhileReplayFails?.run.status).toBe("running");
        const toolCallsWhileReplayFails =
          yield* restarted.executionHistory.listToolCalls("exec_recover");
        expect(toolCallsWhileReplayFails).toHaveLength(0);

        failTerminalWrites = false;
        failRecoveryCleanup = true;
        const recoveredWhileCleanupFails = yield* restarted.executionHistory.get("exec_recover");
        expect(recoveredWhileCleanupFails?.run.status).toBe("completed");
        expect(recoveredWhileCleanupFails?.toolCalls).toHaveLength(1);
        const retainedPendingBlob = yield* blobs.has(
          "u:test-tenant:test-subject/executionHistory",
          "pending-terminal/exec_recover",
        );
        expect(retainedPendingBlob).toBe(true);

        failRecoveryCleanup = false;
        const completedOnly = yield* restarted.executionHistory.list({
          statusFilter: ["completed"],
        });
        expect(completedOnly.total).toBe(1);
        expect(completedOnly.runs[0]?.executionId).toBe("exec_recover");
        const detail = yield* restarted.executionHistory.get("exec_recover");
        expect(detail?.run.status).toBe("completed");
        expect(detail?.run.toolCallCount).toBe(1);
        expect(detail?.toolCalls).toHaveLength(1);
        expect(detail?.toolCalls[0]?.toolCallId).toBe("call_recover");
        const hasPendingBlob = yield* blobs.has(
          "u:test-tenant:test-subject/executionHistory",
          "pending-terminal/exec_recover",
        );
        expect(hasPendingBlob).toBe(false);
        yield* restarted.close();
        yield* Effect.promise(() => config.testDb.close());
      }),
  );

  it.effect("publishes directly when a synthetic recovery anchor cannot write its outbox", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        backend: "sqlite",
        plugins: [executionHistoryPlugin()] as const,
      });
      const baseBlobs = makeInMemoryBlobStore();
      let outboxWriteAttempts = 0;
      const blobs = {
        ...baseBlobs,
        put: (namespace: string, key: string, value: string) => {
          if (key === "pending-terminal/exec_outbox_unavailable") {
            outboxWriteAttempts += 1;
            return Effect.fail(
              new StorageError({
                message: "injected outbox write failure",
                cause: undefined,
              }),
            );
          }
          return baseBlobs.put(namespace, key, value);
        },
      };
      let failInitialRunWrite = true;
      const withInitialWriteFault = (source: typeof config.db): typeof config.db =>
        new Proxy(source, {
          get(target, property, receiver) {
            if (property === "withContext") {
              return (context: unknown) => {
                const withContext = target.withContext;
                return withContext === undefined
                  ? target
                  : withInitialWriteFault(withContext(context));
              };
            }
            if (property === "transaction") {
              const transaction: typeof target.transaction = (run) =>
                target.transaction((transactionDb) => run(withInitialWriteFault(transactionDb)));
              return transaction;
            }
            if (property !== "create") return Reflect.get(target, property, receiver);
            const create: typeof target.create = (table, input) => {
              if (failInitialRunWrite && table === "plugin_storage") {
                // oxlint-disable-next-line executor/no-promise-reject -- boundary: fault-injecting FumaDB Promise adapter must reject so the SDK maps it into StorageFailure
                return Promise.reject(
                  new StorageError({
                    message: "injected initial run write failure",
                    cause: undefined,
                  }),
                );
              }
              return target.create(table, input);
            };
            return create;
          },
        });
      const executor = yield* createExecutor({
        ...config,
        db: withInitialWriteFault(config.db),
        blobs,
      });
      const executionId = ExecutionId.make("exec_outbox_unavailable");
      const initialWrite = yield* Effect.exit(
        executor.executionHistory.handleEvent(
          new ExecutionStarted({
            executionId,
            owner,
            code: "return true",
            trigger: { kind: "manual" },
            startedAt: new Date("2026-05-29T10:00:00.000Z"),
          }),
        ),
      );
      expect(Exit.isFailure(initialWrite)).toBe(true);
      failInitialRunWrite = false;

      yield* executor.executionHistory.handleEvent(
        new ExecutionFinished({
          executionId,
          owner,
          status: "completed",
          result: true,
          completedAt: new Date("2026-05-29T10:00:01.000Z"),
        }),
      );
      expect(outboxWriteAttempts).toBe(1);
      const detail = yield* executor.executionHistory.get("exec_outbox_unavailable");
      expect(detail?.run.status).toBe("completed");
      expect(detail?.run.resultJson).toBe("true");
      const hasPendingBlob = yield* baseBlobs.has(
        "u:test-tenant:test-subject/executionHistory",
        "pending-terminal/exec_outbox_unavailable",
      );
      expect(hasPendingBlob).toBe(false);
      yield* executor.close();
      yield* Effect.promise(() => config.testDb.close());
    }),
  );

  it.effect("cleans a published outbox after terminal cleanup exhausts its retries", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        backend: "sqlite",
        plugins: [executionHistoryPlugin()] as const,
      });
      const baseBlobs = makeInMemoryBlobStore();
      let failDeletes = true;
      let deleteAttempts = 0;
      const blobs = {
        ...baseBlobs,
        delete: (namespace: string, key: string) => {
          if (failDeletes && key === "pending-terminal/exec_cleanup") {
            deleteAttempts += 1;
            return Effect.fail(
              new StorageError({
                message: "injected outbox cleanup failure",
                cause: undefined,
              }),
            );
          }
          return baseBlobs.delete(namespace, key);
        },
      };
      const executor = yield* createExecutor({ ...config, blobs });
      const executionId = ExecutionId.make("exec_cleanup");
      yield* executor.executionHistory.handleEvent(
        new ExecutionStarted({
          executionId,
          owner,
          code: "return true",
          trigger: { kind: "manual" },
          startedAt: new Date("2026-05-29T10:00:00.000Z"),
        }),
      );

      yield* executor.executionHistory.handleEvent(
        new ExecutionFinished({
          executionId,
          owner,
          status: "completed",
          result: true,
          completedAt: new Date("2026-05-29T10:00:01.000Z"),
        }),
      );
      expect(deleteAttempts).toBe(3);

      const visibleWhileCleanupFails = yield* executor.executionHistory.list({
        statusFilter: ["completed"],
      });
      expect(visibleWhileCleanupFails.total).toBe(1);
      const retainedPendingBlob = yield* baseBlobs.has(
        "u:test-tenant:test-subject/executionHistory",
        "pending-terminal/exec_cleanup",
      );
      expect(retainedPendingBlob).toBe(true);

      failDeletes = false;
      const visibleAfterCleanup = yield* executor.executionHistory.list({
        statusFilter: ["completed"],
      });
      expect(visibleAfterCleanup.total).toBe(1);
      const hasPendingBlob = yield* baseBlobs.has(
        "u:test-tenant:test-subject/executionHistory",
        "pending-terminal/exec_cleanup",
      );
      expect(hasPendingBlob).toBe(false);
      yield* executor.close();
      yield* Effect.promise(() => config.testDb.close());
    }),
  );
});
