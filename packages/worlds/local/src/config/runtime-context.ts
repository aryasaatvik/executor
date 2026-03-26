import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { AccountId, WorkspaceId } from "@executor/control-plane/model";
import type {
  LoadedLocalExecutorConfig,
  ResolvedLocalWorkspaceContext,
} from "./config";
import {
  RuntimeLocalWorkspaceMismatchError,
  RuntimeLocalWorkspaceUnavailableError,
} from "../errors";

export type RuntimeLocalWorkspaceState = {
  context: ResolvedLocalWorkspaceContext;
  installation: {
    workspaceId: WorkspaceId;
    accountId: AccountId;
  };
  loadedConfig: LoadedLocalExecutorConfig;
};

export class RuntimeLocalWorkspace extends Context.Tag(
  "#runtime/RuntimeLocalWorkspace",
)<RuntimeLocalWorkspace, RuntimeLocalWorkspaceState>() {}

export const RuntimeLocalWorkspaceLive = (
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState,
) => Layer.succeed(RuntimeLocalWorkspace, runtimeLocalWorkspace);

export const provideOptionalRuntimeLocalWorkspace = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState | null | undefined,
): Effect.Effect<A, E, R> =>
  runtimeLocalWorkspace === null || runtimeLocalWorkspace === undefined
    ? effect
    : effect.pipe(Effect.provide(RuntimeLocalWorkspaceLive(runtimeLocalWorkspace)));

export const getRuntimeLocalWorkspaceOption = () =>
  Effect.contextWith((context) =>
    Context.getOption(context, RuntimeLocalWorkspace),
  ).pipe(
    Effect.map((option) => (Option.isSome(option) ? option.value : null)),
  ) as Effect.Effect<RuntimeLocalWorkspaceState | null, never, never>;

export const requireRuntimeLocalWorkspace = (
  workspaceId?: WorkspaceId,
): Effect.Effect<
  RuntimeLocalWorkspaceState,
  RuntimeLocalWorkspaceUnavailableError | RuntimeLocalWorkspaceMismatchError,
  never
> =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* getRuntimeLocalWorkspaceOption();
    if (runtimeLocalWorkspace === null) {
      return yield* new RuntimeLocalWorkspaceUnavailableError({
          message: "Runtime local workspace is unavailable",
        });
    }

    if (
      workspaceId !== undefined
      && runtimeLocalWorkspace.installation.workspaceId !== workspaceId
    ) {
      return yield* new RuntimeLocalWorkspaceMismatchError({
          message: `Workspace ${workspaceId} is not the active local workspace ${runtimeLocalWorkspace.installation.workspaceId}`,
          requestedWorkspaceId: workspaceId,
          activeWorkspaceId: runtimeLocalWorkspace.installation.workspaceId,
        });
    }

    return runtimeLocalWorkspace;
  });

export const requireRuntimeLocalAccountId = (workspaceId?: WorkspaceId) =>
  requireRuntimeLocalWorkspace(workspaceId).pipe(
    Effect.map((runtimeLocalWorkspace) => runtimeLocalWorkspace.installation.accountId),
  );
