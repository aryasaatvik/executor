import * as Effect from "effect/Effect";
import type { RuntimeRegistryShape } from "@executor/control-plane/ports";

// TODO: Implement with Dynamic Worker Loaders in Phase 6

export const createDynamicWorkerRegistry = (): RuntimeRegistryShape => ({
  get: (_kind) => Effect.fail(new Error("TODO: implement dynamic worker runtime registry get")),
  available: () => Effect.succeed(["cloudflare-dynamic-worker" as const] as any),
  defaultKind: () => Effect.succeed("cloudflare-dynamic-worker" as any),
});
