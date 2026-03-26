import * as Effect from "effect/Effect";
import type { WorkspaceConfigShape } from "@executor/control-plane/ports";

// TODO: Implement with KV in Phase 6

export const createKvWorkspaceConfig = (): WorkspaceConfigShape => ({
  getWorkspaceId: () => Effect.fail(new Error("TODO: implement KV workspace config getWorkspaceId")),
  getAccountId: () => Effect.fail(new Error("TODO: implement KV workspace config getAccountId")),
});
