import { FileSystem } from "@effect/platform";
import * as Effect from "effect/Effect";

import {
  type LoadedLocalExecutorConfig,
  type ResolvedLocalWorkspaceContext,
} from "./config";
import { loadLocalWorkspaceState, writeLocalWorkspaceState, type LocalWorkspaceState } from "./workspace-state";

const pruneLocalWorkspaceState = (input: {
  context: ResolvedLocalWorkspaceContext;
  loadedConfig: LoadedLocalExecutorConfig;
}): Effect.Effect<LocalWorkspaceState, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const currentState = yield* loadLocalWorkspaceState(input.context);

    const configuredSourceIds = new Set(
      Object.keys(input.loadedConfig.config?.sources ?? {}),
    );
    const nextState: LocalWorkspaceState = {
      ...currentState,
      sources: Object.fromEntries(
        Object.entries(currentState.sources).filter(([sourceId]) =>
          configuredSourceIds.has(sourceId)
        ),
      ),
    };

    if (JSON.stringify(nextState) === JSON.stringify(currentState)) {
      return currentState;
    }

    yield* writeLocalWorkspaceState({
      context: input.context,
      state: nextState,
    });

    return nextState;
  });

export const synchronizeLocalWorkspaceState = (input: {
  context: ResolvedLocalWorkspaceContext;
  loadedConfig: LoadedLocalExecutorConfig;
}): Effect.Effect<LoadedLocalExecutorConfig["config"], Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    yield* pruneLocalWorkspaceState({
      context: input.context,
      loadedConfig: input.loadedConfig,
    });

    return input.loadedConfig.config;
  });
