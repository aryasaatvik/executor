import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { RuntimeKind, ExecutionRuntime } from "@executor/execution-contract";

// TODO: Migrate to ServiceMap.Service when moving to Effect v4

export interface RuntimeRegistryShape {
  readonly get: (kind: RuntimeKind) => Effect.Effect<ExecutionRuntime, Error>;

  readonly available: () => Effect.Effect<ReadonlyArray<RuntimeKind>, Error>;

  readonly defaultKind: () => Effect.Effect<RuntimeKind, Error>;
}

export class RuntimeRegistry extends Context.Tag(
  "@executor/core/RuntimeRegistry",
)<RuntimeRegistry, RuntimeRegistryShape>() {}
