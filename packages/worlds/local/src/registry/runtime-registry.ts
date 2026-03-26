import * as Effect from "effect/Effect";
import type { RuntimeRegistryShape } from "@executor/control-plane/ports";

export const createLocalRuntimeRegistry = (): RuntimeRegistryShape => ({
  get: (_kind) => Effect.fail(new Error("TODO: implement local runtime registry get")),
  available: () => Effect.succeed(["quickjs", "ses", "deno-subprocess"] as const),
  defaultKind: () => Effect.succeed("quickjs" as const),
});
