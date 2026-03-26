// RuntimeLocalWorkspace — copied from @executor/engine/src/runtime/local/runtime-context.ts
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { AccountId, WorkspaceId } from "../../model/index";
import type {
  LoadedLocalExecutorConfig,
  ResolvedLocalWorkspaceContext,
} from "./local-config";
import {
  RuntimeLocalWorkspaceMismatchError,
  RuntimeLocalWorkspaceUnavailableError,
} from "./local-errors";

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

export const provideOptionalRuntimeLocalWorkspace = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState | null | undefined,
): Effect.Effect<A, E, R> =>
  runtimeLocalWorkspace === null || runtimeLocalWorkspace === undefined
    ? effect
    : effect.pipe(
        Effect.provideService(RuntimeLocalWorkspace, runtimeLocalWorkspace),
      );

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
      workspaceId !== undefined &&
      runtimeLocalWorkspace.installation.workspaceId !== workspaceId
    ) {
      return yield* new RuntimeLocalWorkspaceMismatchError({
        message: `Workspace ${workspaceId} is not the active local workspace ${runtimeLocalWorkspace.installation.workspaceId}`,
        requestedWorkspaceId: workspaceId,
        activeWorkspaceId:
          runtimeLocalWorkspace.installation.workspaceId,
      });
    }

    return runtimeLocalWorkspace;
  });
