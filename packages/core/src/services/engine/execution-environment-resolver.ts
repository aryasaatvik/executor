// ExecutionEnvironmentResolver — local Context.Tag definition
// Copied from @executor/engine/src/runtime/execution/workspace/environment.ts
import * as Context from "effect/Context";

import type { ResolveExecutionEnvironment } from "../execution/execution-state";

export type { ResolveExecutionEnvironment };

export class ExecutionEnvironmentResolver extends Context.Tag(
  "#runtime/ExecutionEnvironmentResolver",
)<ExecutionEnvironmentResolver, ResolveExecutionEnvironment>() {}
