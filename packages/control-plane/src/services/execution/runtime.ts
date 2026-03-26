import type { CodeExecutor } from "@executor/codemode-core";
// TODO: These imports reference engine internals and should be replaced
// with control-plane or execution-contract types once available
import { makeDenoSubprocessExecutor } from "@executor/execution-runtime-deno-subprocess";
import { makeQuickJsExecutor } from "@executor/execution-runtime-quickjs";
import { makeSesExecutor } from "@executor/execution-runtime-ses";
import type { LocalExecutorConfig, LocalExecutorRuntime } from "../../model";

const DEFAULT_EXECUTION_RUNTIME: LocalExecutorRuntime = "quickjs";

export const resolveConfiguredExecutionRuntime = (
  config: LocalExecutorConfig | null | undefined,
): LocalExecutorRuntime => config?.runtime ?? DEFAULT_EXECUTION_RUNTIME;

export const createCodeExecutorForRuntime = (
  runtime: LocalExecutorRuntime,
): CodeExecutor => {
  switch (runtime) {
    case "deno":
      return makeDenoSubprocessExecutor();
    case "ses":
      return makeSesExecutor();
    case "quickjs":
    default:
      return makeQuickJsExecutor();
  }
};
