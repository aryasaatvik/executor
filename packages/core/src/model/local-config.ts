import { Schema } from "effect";

import { SecretRefSchema } from "./auth";

// ---------------------------------------------------------------------------
// LocalExecutorRuntime
// ---------------------------------------------------------------------------

export const LocalExecutorRuntimeSchema = Schema.Literal(
  "quickjs",
  "ses",
  "deno",
);

export type LocalExecutorRuntime = typeof LocalExecutorRuntimeSchema.Type;

// ---------------------------------------------------------------------------
// Secret config types
// ---------------------------------------------------------------------------

export const LocalConfigSecretProviderSourceSchema = Schema.Literal(
  "env",
  "file",
  "exec",
  "params",
);

export const LocalConfigExplicitSecretRefSchema = Schema.Struct({
  source: LocalConfigSecretProviderSourceSchema,
  provider: Schema.String,
  id: Schema.String,
});

export const LocalConfigSecretInputSchema = Schema.Union(
  Schema.String,
  LocalConfigExplicitSecretRefSchema,
);

export type LocalConfigSecretInput = typeof LocalConfigSecretInputSchema.Type;

// ---------------------------------------------------------------------------
// Source connection
// ---------------------------------------------------------------------------

export const LocalConfigSourceConnectionSchema = Schema.Struct({
  endpoint: Schema.String,
  auth: Schema.optional(LocalConfigSecretInputSchema),
});

// ---------------------------------------------------------------------------
// LocalConfigSource
//
// The full schema depends on engine-internal source adapters. We define
// the structural type here so downstream consumers have the shape.
// ---------------------------------------------------------------------------

export type LocalConfigSource = {
  kind: string;
  binding: Record<string, unknown>;
  name?: string;
  namespace?: string;
  iconUrl?: string;
  enabled?: boolean;
  connection: {
    endpoint: string;
    auth?: LocalConfigSecretInput;
  };
};

// ---------------------------------------------------------------------------
// Secret providers
// ---------------------------------------------------------------------------

export const LocalConfigEnvSecretProviderSchema = Schema.Struct({
  source: Schema.Literal("env"),
});

export const LocalConfigFileSecretProviderModeSchema = Schema.Literal(
  "singleValue",
  "json",
);

export const LocalConfigFileSecretProviderSchema = Schema.Struct({
  source: Schema.Literal("file"),
  path: Schema.String,
  mode: Schema.optional(LocalConfigFileSecretProviderModeSchema),
});

export const LocalConfigExecSecretProviderSchema = Schema.Struct({
  source: Schema.Literal("exec"),
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  allowSymlinkCommand: Schema.optional(Schema.Boolean),
  trustedDirs: Schema.optional(Schema.Array(Schema.String)),
});

export const LocalConfigSecretProviderSchema = Schema.Union(
  LocalConfigEnvSecretProviderSchema,
  LocalConfigFileSecretProviderSchema,
  LocalConfigExecSecretProviderSchema,
);

export const LocalConfigSecretsSchema = Schema.Struct({
  providers: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: LocalConfigSecretProviderSchema,
    }),
  ),
  defaults: Schema.optional(
    Schema.Struct({
      env: Schema.optional(Schema.String),
      file: Schema.optional(Schema.String),
      exec: Schema.optional(Schema.String),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Remaining config sections
// ---------------------------------------------------------------------------

export const LocalConfigWorkspaceSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
});

export const LocalConfigDaemonSchema = Schema.Struct({
  baseUrl: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Number),
});

export const LocalConfigCallSchema = Schema.Struct({
  baseUrl: Schema.optional(Schema.String),
  noOpen: Schema.optional(Schema.Boolean),
});

export const LocalConfigSearchSchema = Schema.Struct({
  limit: Schema.optional(Schema.Number),
  source: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
});

export const LocalConfigSemanticSearchSchema = Schema.Struct({
  provider: Schema.String,
  model: Schema.optional(Schema.String),
  apiKeyRef: Schema.optional(SecretRefSchema),
  dimensions: Schema.optional(Schema.Number),
});

// ---------------------------------------------------------------------------
// LocalExecutorConfig
//
// The full schema in engine depends on adapter-derived source schemas.
// We define a structural type that matches the shape.
// ---------------------------------------------------------------------------

export const LocalConfigSourceSchema = Schema.Struct({
  kind: Schema.String,
  binding: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  name: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  iconUrl: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  connection: LocalConfigSourceConnectionSchema,
});

export const LocalExecutorConfigSchema = Schema.Struct({
  runtime: Schema.optional(LocalExecutorRuntimeSchema),
  workspace: Schema.optional(LocalConfigWorkspaceSchema),
  daemon: Schema.optional(LocalConfigDaemonSchema),
  call: Schema.optional(LocalConfigCallSchema),
  search: Schema.optional(LocalConfigSearchSchema),
  semanticSearch: Schema.optional(Schema.NullOr(LocalConfigSemanticSearchSchema)),
  sources: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: LocalConfigSourceSchema,
    }),
  ),
  secrets: Schema.optional(LocalConfigSecretsSchema),
});

export type LocalConfigSecretProvider = typeof LocalConfigSecretProviderSchema.Type;
export type LocalConfigDaemon = typeof LocalConfigDaemonSchema.Type;
export type LocalConfigCall = typeof LocalConfigCallSchema.Type;
export type LocalConfigSearch = typeof LocalConfigSearchSchema.Type;
export type LocalExecutorConfig = typeof LocalExecutorConfigSchema.Type;
