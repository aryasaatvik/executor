import * as Data from "effect/Data";

export class ExecutorAppEffectError extends Data.TaggedError(
  "ExecutorAppEffectError",
)<{
  readonly module: string;
  readonly message: string;
}> {}

export const executorAppEffectError = (
  module: string,
  message: string,
) => new ExecutorAppEffectError({ module, message });

export class LocalServerReachabilityTimeoutError extends Data.TaggedError(
  "LocalServerReachabilityTimeoutError",
)<{
  readonly baseUrl: string;
  readonly action: "start" | "shutdown";
  readonly logFile: string;
  readonly logTail: string | null;
  readonly message: string;
}> {}

export const localServerReachabilityTimeoutError = (input: {
  baseUrl: string;
  expected: boolean;
  logFile: string;
  logTail: string | null;
}) =>
  new LocalServerReachabilityTimeoutError({
    baseUrl: input.baseUrl,
    action: input.expected ? "start" : "shutdown",
    logFile: input.logFile,
    logTail: input.logTail,
    message:
      input.logTail === null
        ? `Timed out waiting for local executor server ${input.expected ? "start" : "shutdown"} at ${input.baseUrl}\n\nDaemon log: ${input.logFile}`
        : `Timed out waiting for local executor server ${input.expected ? "start" : "shutdown"} at ${input.baseUrl}\n\nRecent daemon log (${input.logFile}):\n${input.logTail}`,
  });
