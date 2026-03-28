// Local config types — copied from @executor/engine/src/runtime/local/config.ts
import type { LocalExecutorConfig } from "../../model/index";

export type ResolvedLocalWorkspaceContext = {
  cwd: string;
  workspaceRoot: string;
  workspaceName: string;
  configDirectory: string;
  projectConfigPath: string;
  homeConfigPath: string;
  homeStateDirectory: string;
  artifactsDirectory: string;
  stateDirectory: string;
};

export type LoadedLocalExecutorConfig = {
  config: LocalExecutorConfig | null;
  homeConfig: LocalExecutorConfig | null;
  projectConfig: LocalExecutorConfig | null;
  homeConfigPath: string;
  projectConfigPath: string;
};
