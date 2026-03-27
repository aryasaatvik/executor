import type { CodeExecutor, ExecuteResult } from "@executor/codemode-core";
import type { RuntimeRegistryShape } from "@executor/control-plane/ports";
import {
  type ExecutionEvent,
  type ExecutionRuntime,
  type PrepareInput,
  type PreparedSession,
  type RuntimeHandle,
  type RuntimeKind,
} from "@executor/execution-contract";
import { makeDenoSubprocessExecutor } from "@executor/execution-runtime-deno-subprocess";
import { makeQuickJsExecutor } from "@executor/execution-runtime-quickjs";
import { makeSesExecutor } from "@executor/execution-runtime-ses";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const AVAILABLE_RUNTIMES = [
  "quickjs",
  "ses",
  "deno-subprocess",
] as const satisfies ReadonlyArray<RuntimeKind>;

type StoredPreparedSession = {
  readonly runtimeKind: RuntimeKind;
  readonly input: PrepareInput;
};

const createExecutionRuntime = (input: {
  kind: RuntimeKind;
  executor: CodeExecutor;
  requirements: ExecutionRuntime["requirements"];
}): ExecutionRuntime => {
  const sessions = new Map<string, StoredPreparedSession>();

  const readPreparedSession = (
    session: PreparedSession,
  ): Effect.Effect<StoredPreparedSession, Error> =>
    Effect.sync(() => sessions.get(session.id) ?? null).pipe(
      Effect.flatMap((stored) =>
        stored === null
          ? Effect.fail(
              new Error(`Prepared session not found: ${session.id}`),
            )
          : Effect.succeed(stored),
      ),
    );

  const toEvents = (result: ExecuteResult): ReadonlyArray<ExecutionEvent> => {
    const now = Date.now();
    const logEvents = (result.logs ?? []).map(
      (message): ExecutionEvent => ({
        _tag: "LogEvent",
        level: "info",
        message,
        timestamp: now,
      }),
    );

    if (typeof result.error === "string" && result.error.length > 0) {
      return [
        ...logEvents,
        {
          _tag: "ErrorEvent",
          error: result.error,
          timestamp: Date.now(),
        },
      ];
    }

    return [
      ...logEvents,
      {
        _tag: "ResultEvent",
        result: result.result,
        logs: result.logs,
        timestamp: Date.now(),
      },
    ];
  };

  return {
    kind: input.kind,
    requirements: input.requirements,

    prepare: (prepareInput) =>
      Effect.sync(() => {
        const session = {
          id: crypto.randomUUID(),
          runtimeKind: input.kind,
        } satisfies PreparedSession;

        sessions.set(session.id, {
          runtimeKind: input.kind,
          input: prepareInput,
        });

        return session;
      }),

    start: (session) =>
      Stream.unwrap(
        readPreparedSession(session).pipe(
          Effect.tap(() => Effect.sync(() => sessions.delete(session.id))),
          Effect.flatMap((stored) =>
            stored.input.toolInvoker.invoke === undefined
              ? Effect.fail(new Error(`Prepared session missing tool invoker: ${session.id}`))
              : input.executor.execute(stored.input.code, stored.input.toolInvoker),
          ),
          Effect.map((result) => Stream.fromIterable(toEvents(result))),
        ),
      ),

    stop: (handle: RuntimeHandle) =>
      Effect.sync(() => {
        sessions.delete(handle.sessionId);
      }),
  };
};

export const createLocalRuntimeRegistry = (): RuntimeRegistryShape => {
  const runtimes = new Map<RuntimeKind, ExecutionRuntime>([
    [
      "quickjs",
      createExecutionRuntime({
        kind: "quickjs",
        executor: makeQuickJsExecutor(),
        requirements: {
          isolation: "vm",
          networkAccess: false,
          fileSystemAccess: false,
        },
      }),
    ],
    [
      "ses",
      createExecutionRuntime({
        kind: "ses",
        executor: makeSesExecutor(),
        requirements: {
          isolation: "compartment",
          networkAccess: false,
          fileSystemAccess: false,
        },
      }),
    ],
    [
      "deno-subprocess",
      createExecutionRuntime({
        kind: "deno-subprocess",
        executor: makeDenoSubprocessExecutor(),
        requirements: {
          isolation: "process",
          networkAccess: false,
          fileSystemAccess: false,
        },
      }),
    ],
  ]);

  return {
    get: (kind) =>
      Effect.sync(() => runtimes.get(kind) ?? null).pipe(
        Effect.flatMap((runtime) =>
          runtime === null
            ? Effect.fail(new Error(`Unsupported local runtime: ${kind}`))
            : Effect.succeed(runtime),
        ),
      ),
    available: () => Effect.succeed(AVAILABLE_RUNTIMES),
    defaultKind: () => Effect.succeed("quickjs"),
  };
};
