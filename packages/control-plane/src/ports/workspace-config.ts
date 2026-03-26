import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { AccountId, WorkspaceId } from "../model/index";

// TODO: Migrate to ServiceMap.Service when moving to Effect v4

export interface WorkspaceConfigShape {
  readonly getWorkspaceId: () => Effect.Effect<WorkspaceId, Error>;

  readonly getAccountId: () => Effect.Effect<AccountId, Error>;
}

export class WorkspaceConfig extends Context.Tag(
  "@executor/control-plane/WorkspaceConfig",
)<WorkspaceConfig, WorkspaceConfigShape>() {}
