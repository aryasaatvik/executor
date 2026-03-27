import type { CodeExecutor, ExecuteResult } from "@executor/codemode-core";
import type { ExecutionRuntime, RuntimeKind } from "@executor/execution-contract";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { LocalExecutorConfig } from "../../model";

const DEFAULT_EXECUTION_RUNTIME: RuntimeKind = "quickjs";

export const resolveConfiguredExecutionRuntime = (
  config: LocalExecutorConfig | null | undefined,
): RuntimeKind => {
  const runtime = config?.runtime as string | undefined;

  switch (runtime) {
    case "deno":
    case "deno-subprocess":
      return "deno-subprocess";
    case "ses":
      return "ses";
    case "cloudflare-dynamic-worker":
      return "cloudflare-dynamic-worker";
    case "quickjs":
    default:
      return DEFAULT_EXECUTION_RUNTIME;
  }
};

export const createCodeExecutorForRuntime = (
  runtime: ExecutionRuntime,
): CodeExecutor => ({
  execute: (code, toolInvoker) =>
    Effect.gen(function* () {
      const session = yield* runtime.prepare({
        code,
        toolInvoker,
      });

      const final = yield* runtime.start(session).pipe(
        Stream.runFold(
          {
            logs: [] as string[],
            result: undefined as unknown,
            error: undefined as string | undefined,
          },
          (state, event): ExecuteResult & { logs: string[] } => {
            switch (event._tag) {
              case "LogEvent":
                return {
                  ...state,
                  logs: [...state.logs, event.message],
                };
              case "ResultEvent":
                return {
                  ...state,
                  result: event.result,
                };
              case "ErrorEvent":
                return {
                  ...state,
                  error: event.error,
                };
              default:
                return state;
            }
          },
        ),
      );

      return {
        result: final.result,
        error: final.error,
        logs: final.logs.length > 0 ? final.logs : undefined,
      } satisfies ExecuteResult;
    }),
});
