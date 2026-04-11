export {
  ExecutorFileConfig,
  SourceConfig,
  OpenApiSourceConfig,
  GraphqlSourceConfig,
  McpRemoteSourceConfig,
  McpStdioSourceConfig,
  McpAuthConfig,
  SecretMetadata,
  ConfigHeaderValue,
  SECRET_REF_PREFIX,
} from "./schema";

export { loadConfig, ConfigParseError } from "./load";
export {
  getExecutorPaths,
  resolveExecutorPaths,
  copyLegacyFileIfMissing,
  type ExecutorPlatform,
  type ExecutorPathEnv,
  type ExecutorPathInputs,
  type ExecutorPaths,
  type GetExecutorPathsOptions,
  type LegacyFileCopyResult,
  type LegacyFileCopyFileSystem,
  type CopyLegacyFileIfMissingOptions,
} from "./platform-paths";

export {
  addSourceToConfig,
  removeSourceFromConfig,
  writeConfig,
  addSecretToConfig,
  removeSecretFromConfig,
} from "./write";
