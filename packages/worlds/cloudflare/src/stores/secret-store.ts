import * as Effect from "effect/Effect";
import type { SecretStoreShape } from "@executor/control-plane/ports";

// TODO: Implement with KV in Phase 6

export const createKvSecretStore = (): SecretStoreShape => ({
  list: () => Effect.fail(new Error("TODO: implement KV secret store list")),
  getByHandle: (_input) => Effect.fail(new Error("TODO: implement KV secret store getByHandle")),
  resolve: (_input) => Effect.fail(new Error("TODO: implement KV secret store resolve")),
  create: (_input) => Effect.fail(new Error("TODO: implement KV secret store create")),
  update: (_input) => Effect.fail(new Error("TODO: implement KV secret store update")),
  remove: (_input) => Effect.fail(new Error("TODO: implement KV secret store remove")),
});
