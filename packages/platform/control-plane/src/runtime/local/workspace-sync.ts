import * as Effect from "effect/Effect";

import {
  type LoadedLocalExecutorConfig,
  type ResolvedLocalWorkspaceContext,
} from "./config";

export const synchronizeLocalWorkspaceState = (input: {
  context: ResolvedLocalWorkspaceContext;
  loadedConfig: LoadedLocalExecutorConfig;
}): Effect.Effect<LoadedLocalExecutorConfig["config"], never, never> =>
  Effect.succeed(input.loadedConfig.config);
