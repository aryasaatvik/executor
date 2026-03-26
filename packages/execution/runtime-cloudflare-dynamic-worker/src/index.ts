import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { ExecutionRuntime } from "@executor/execution-contract";

/**
 * Create a Cloudflare Dynamic Worker execution runtime.
 *
 * Stub implementation — real execution via Dynamic Worker Loaders
 * will be implemented in Phase 6.
 */
export const createDynamicWorkerRuntime = (): ExecutionRuntime => ({
  kind: "cloudflare-dynamic-worker",

  requirements: {
    isolation: "worker",
    networkAccess: true,
    fileSystemAccess: false,
  },

  prepare: (_input) =>
    Effect.succeed({
      id: `cfdw-${Date.now()}`,
      runtimeKind: "cloudflare-dynamic-worker" as const,
    }),

  start: (_session) =>
    Stream.make({
      _tag: "ErrorEvent" as const,
      error: "cloudflare-dynamic-worker runtime is not yet implemented",
      timestamp: Date.now(),
    }),

  stop: (_handle) => Effect.void,
});
