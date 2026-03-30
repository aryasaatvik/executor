import type {
  GoogleDiscoveryOAuthSession,
  GoogleDiscoveryStoredSourceData,
} from "@executor/plugin-google-discovery-shared";
import type {
  GoogleDiscoveryOAuthSessionStorage,
  GoogleDiscoverySourceStorage,
} from "@executor/plugin-google-discovery-sdk";
import type {
  GraphqlStoredSourceData,
} from "@executor/plugin-graphql-shared";
import type {
  GraphqlSourceStorage,
} from "@executor/plugin-graphql-sdk";
import type {
  McpOAuthSession,
  McpStoredSourceData,
} from "@executor/plugin-mcp-shared";
import type {
  McpOAuthSessionStorage,
  McpSourceStorage,
} from "@executor/plugin-mcp-sdk";
import type {
  OpenApiStoredSourceData,
} from "@executor/plugin-openapi-shared";
import type {
  OpenApiSourceStorage,
} from "@executor/plugin-openapi-sdk";
import type {
  OnePasswordStoreStorage,
} from "@executor/plugin-onepassword-sdk";
import type {
  OnePasswordStoredStoreData,
} from "@executor/plugin-onepassword-shared";
import * as Effect from "effect/Effect";
import { resolve } from "node:path";

import { createFileGoogleDiscoveryOAuthSessionStorage } from "./google-discovery-oauth-session-storage";
import { createFileGoogleDiscoverySourceStorage } from "./google-discovery-source-storage";
import { createFileGraphqlSourceStorage } from "./graphql-source-storage";
import { createFileMcpOAuthSessionStorage } from "./mcp-oauth-session-storage";
import { createFileMcpSourceStorage } from "./mcp-source-storage";
import { createFileOpenApiSourceStorage } from "./openapi-source-storage";
import { createFileOnePasswordStoreStorage } from "./onepassword-store-storage";

type ScopedStorage<TValue, TIdKey extends string> = {
  get: (input: {
    scopeId: string;
  } & Record<TIdKey, string>) => Effect.Effect<TValue | null, Error, never>;
  put: (input: {
    scopeId: string;
    value: TValue;
  } & Record<TIdKey, string>) => Effect.Effect<void, Error, never>;
  remove: (input: {
    scopeId: string;
  } & Record<TIdKey, string>) => Effect.Effect<void, Error, never>;
};

type SessionStorage<TValue> = {
  get: (sessionId: string) => Effect.Effect<TValue | null, Error, never>;
  put: (input: {
    sessionId: string;
    value: TValue;
  }) => Effect.Effect<void, Error, never>;
  remove: (sessionId: string) => Effect.Effect<void, Error, never>;
};

export type ServerPluginStorage = {
  graphqlStorage: GraphqlSourceStorage;
  googleDiscoveryStorage: GoogleDiscoverySourceStorage;
  googleDiscoveryOAuthSessions: GoogleDiscoveryOAuthSessionStorage;
  mcpStorage: McpSourceStorage;
  mcpOAuthSessions: McpOAuthSessionStorage;
  openApiStorage: OpenApiSourceStorage;
  onePasswordStorage: OnePasswordStoreStorage;
};

export const isInMemoryLocalDataDir = (localDataDir: string): boolean =>
  localDataDir === ":memory:";

const createInMemoryScopedStorage = <
  TValue,
  TIdKey extends string,
>(
  idKey: TIdKey,
): ScopedStorage<TValue, TIdKey> => {
  const records = new Map<string, TValue>();
  const keyOf = (input: { scopeId: string } & Record<TIdKey, string>) =>
    `${input.scopeId}:${input[idKey]}`;

  return {
    get: (input) =>
      Effect.succeed(records.get(keyOf(input)) ?? null),
    put: (input) =>
      Effect.sync(() => {
        records.set(keyOf(input), input.value);
      }),
    remove: (input) =>
      Effect.sync(() => {
        records.delete(keyOf(input));
      }),
  };
};

const createInMemorySessionStorage = <TValue,>(): SessionStorage<TValue> => {
  const sessions = new Map<string, TValue>();

  return {
    get: (sessionId) =>
      Effect.succeed(sessions.get(sessionId) ?? null),
    put: (input) =>
      Effect.sync(() => {
        sessions.set(input.sessionId, input.value);
      }),
    remove: (sessionId) =>
      Effect.sync(() => {
        sessions.delete(sessionId);
      }),
  };
};

export const createServerPluginStorage = (
  localDataDir: string,
): ServerPluginStorage => {
  if (isInMemoryLocalDataDir(localDataDir)) {
    return {
      graphqlStorage: createInMemoryScopedStorage<
        GraphqlStoredSourceData,
        "sourceId"
      >("sourceId"),
      googleDiscoveryStorage: createInMemoryScopedStorage<
        GoogleDiscoveryStoredSourceData,
        "sourceId"
      >("sourceId"),
      googleDiscoveryOAuthSessions: createInMemorySessionStorage<
        GoogleDiscoveryOAuthSession
      >(),
      mcpStorage: createInMemoryScopedStorage<McpStoredSourceData, "sourceId">(
        "sourceId",
      ),
      mcpOAuthSessions: createInMemorySessionStorage<McpOAuthSession>(),
      openApiStorage: createInMemoryScopedStorage<
        OpenApiStoredSourceData,
        "sourceId"
      >("sourceId"),
      onePasswordStorage: createInMemoryScopedStorage<
        OnePasswordStoredStoreData,
        "storeId"
      >("storeId"),
    };
  }

  return {
    graphqlStorage: createFileGraphqlSourceStorage({
      rootDir: resolve(localDataDir, "plugins", "graphql", "sources"),
    }),
    googleDiscoveryStorage: createFileGoogleDiscoverySourceStorage({
      rootDir: resolve(localDataDir, "plugins", "google-discovery", "sources"),
    }),
    googleDiscoveryOAuthSessions: createFileGoogleDiscoveryOAuthSessionStorage({
      rootDir: resolve(localDataDir, "plugins", "google-discovery", "oauth-sessions"),
    }),
    mcpStorage: createFileMcpSourceStorage({
      rootDir: resolve(localDataDir, "plugins", "mcp", "sources"),
    }),
    mcpOAuthSessions: createFileMcpOAuthSessionStorage({
      rootDir: resolve(localDataDir, "plugins", "mcp", "oauth-sessions"),
    }),
    openApiStorage: createFileOpenApiSourceStorage({
      rootDir: resolve(localDataDir, "plugins", "openapi", "sources"),
    }),
    onePasswordStorage: createFileOnePasswordStoreStorage({
      rootDir: resolve(localDataDir, "plugins", "onepassword", "stores"),
    }),
  };
};
