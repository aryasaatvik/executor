import {
  defineExecutorSearchPlugin,
} from "@executor/platform-sdk/plugins";

import {
  SQLITE_SEARCH_PLUGIN_KEY,
  SQLITE_SEARCH_PROVIDER_KEY,
  SqliteSearchProviderConfigSchema,
} from "./shared";
import { createSqliteSearchProvider } from "./runtime";

export const sqliteSearchSdkPlugin = () =>
  defineExecutorSearchPlugin({
    key: SQLITE_SEARCH_PLUGIN_KEY,
    search: {
      providerKey: SQLITE_SEARCH_PROVIDER_KEY,
      displayName: "SQLite Search",
      configSchema: SqliteSearchProviderConfigSchema,
      create: createSqliteSearchProvider,
    },
  });

export * from "./shared";
