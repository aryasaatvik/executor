import {
  defineExecutorSearchPlugin,
} from "@executor/platform-sdk/plugins";

import {
  SQLITE_SEARCH_PLUGIN_KEY,
  SQLITE_SEARCH_PROVIDER_KEY,
  SqliteSearchProviderConfigSchema,
  type SqliteSearchProviderConfig,
  type SqliteSearchSemanticEmbedderConfig,
} from "./shared";
import { createSqliteSearchProvider } from "./runtime";

export type SqliteSearchSdkPluginOptions = {
  defaultConfig?: Partial<SqliteSearchProviderConfig>;
};

const mergeSqliteSearchEmbedderConfig = (
  config?: SqliteSearchSemanticEmbedderConfig,
  defaultConfig?: SqliteSearchSemanticEmbedderConfig,
): SqliteSearchSemanticEmbedderConfig | undefined => {
  if (config === undefined) {
    return defaultConfig;
  }

  if (defaultConfig === undefined) {
    return config;
  }

  const resolvedConfigKind = config.kind ?? "hash-v1";
  const resolvedDefaultKind = defaultConfig.kind ?? "hash-v1";

  if (resolvedConfigKind !== resolvedDefaultKind) {
    return config;
  }

  return {
    ...defaultConfig,
    ...config,
  } as SqliteSearchSemanticEmbedderConfig;
};

const mergeSqliteSearchProviderConfig = (
  config: SqliteSearchProviderConfig,
  defaultConfig?: Partial<SqliteSearchProviderConfig>,
): SqliteSearchProviderConfig => ({
  ...defaultConfig,
  ...config,
  ...(defaultConfig?.embedder || config.embedder
    ? {
        embedder: mergeSqliteSearchEmbedderConfig(
          config.embedder,
          defaultConfig?.embedder,
        ),
      }
    : {}),
  ...(defaultConfig?.vector || config.vector
    ? {
        vector: {
          ...(defaultConfig?.vector ?? {}),
          ...(config.vector ?? {}),
        },
      }
    : {}),
  ...(defaultConfig?.ranking || config.ranking
    ? {
        ranking: {
          ...(defaultConfig?.ranking ?? {}),
          ...(config.ranking ?? {}),
        },
      }
    : {}),
});

export const sqliteSearchSdkPlugin = (options: SqliteSearchSdkPluginOptions = {}) =>
  defineExecutorSearchPlugin({
    key: SQLITE_SEARCH_PLUGIN_KEY,
    search: {
      providerKey: SQLITE_SEARCH_PROVIDER_KEY,
      displayName: "SQLite Search",
      configSchema: SqliteSearchProviderConfigSchema,
      create: (input) =>
        createSqliteSearchProvider({
          ...input,
          config: mergeSqliteSearchProviderConfig(
            input.config,
            options.defaultConfig,
          ),
        }),
    },
  });

export * from "./shared";
