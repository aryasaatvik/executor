import * as Effect from "effect/Effect";
import type { SecretStoreShape } from "@executor/core/ports";

export const createLocalSecretStore = (): SecretStoreShape => ({
  list: () => Effect.fail(new Error("TODO: implement local secret store list")),
  getByHandle: (_input) => Effect.fail(new Error("TODO: implement local secret store getByHandle")),
  resolve: (_input) => Effect.fail(new Error("TODO: implement local secret store resolve")),
  create: (_input) => Effect.fail(new Error("TODO: implement local secret store create")),
  update: (_input) => Effect.fail(new Error("TODO: implement local secret store update")),
  remove: (_input) => Effect.fail(new Error("TODO: implement local secret store remove")),
});
