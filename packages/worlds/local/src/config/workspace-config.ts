import * as Effect from "effect/Effect";
import type { WorkspaceConfigShape } from "@executor/control-plane/ports";

export const createLocalWorkspaceConfig = (): WorkspaceConfigShape => ({
  getWorkspaceId: () => Effect.fail(new Error("TODO: implement local workspace config getWorkspaceId")),
  getAccountId: () => Effect.fail(new Error("TODO: implement local workspace config getAccountId")),
});
