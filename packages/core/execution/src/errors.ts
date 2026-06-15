// `ExecutionToolError` is the tool-discovery error channel. It now lives in
// `@executor-js/sdk` beside the tool-discovery contract (`ToolDiscoveryProvider`)
// so the plugin spec can name that contract without a `sdk -> execution` cycle.
// Re-exported here so in-package imports (`./errors`) and the public
// `@executor-js/execution/core` surface keep resolving the same class.
export { ExecutionToolError } from "@executor-js/sdk/core";

// `CodeExecutionError` lives in `@executor-js/codemode-core` — the `CodeExecutor`
// interface uses it as the default error channel, so the runtime packages
// can import the same class directly.
export { CodeExecutionError } from "@executor-js/codemode-core";
