import * as Schema from "effect/Schema";
import type {
  ExecutorSearchProviderContext,
} from "@executor/platform-sdk/runtime";

export const SQLITE_SEARCH_PROVIDER_KEY = "sqlite";
export const SQLITE_SEARCH_PLUGIN_KEY = "search-sqlite";
export const SQLITE_SEARCH_BACKEND = "sqlite-fts5";
export const SQLITE_SEARCH_HYBRID_BACKEND = "sqlite-fts5+sqlite-vec";
export const SQLITE_SEARCH_DEFAULT_DB_NAME = "search";
export const SQLITE_SEARCH_DEFAULT_EMBEDDER = "hash-v1";
export const SQLITE_SEARCH_DEFAULT_VECTOR_BACKEND = "sqlite-vec";
export const SQLITE_SEARCH_DEFAULT_HASH_DIMENSIONS = 256;

export const SqliteSearchHashEmbedderConfigSchema = Schema.Struct({
  kind: Schema.optional(Schema.Literal("hash-v1")),
  dimensions: Schema.optional(Schema.Number),
});

export const SqliteSearchGoogleEmbedderConfigSchema = Schema.Struct({
  kind: Schema.Literal("google"),
  dimensions: Schema.Literal(2048, 3072),
});

export const SqliteSearchSemanticEmbedderConfigSchema = Schema.Union(
  SqliteSearchHashEmbedderConfigSchema,
  SqliteSearchGoogleEmbedderConfigSchema,
);

export const SqliteSearchSemanticVectorConfigSchema = Schema.Struct({
  kind: Schema.optional(Schema.Literal("sqlite-vec")),
  extensionPath: Schema.optional(Schema.String),
  maxCandidates: Schema.optional(Schema.Number),
});

export const SqliteSearchHybridRankingConfigSchema = Schema.Struct({
  ftsWeight: Schema.optional(Schema.Number),
  vectorWeight: Schema.optional(Schema.Number),
  rrfK: Schema.optional(Schema.Number),
});

export const SqliteSearchProviderConfigSchema = Schema.Struct({
  databasePath: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.Literal("fts", "hybrid")),
  embedder: Schema.optional(SqliteSearchSemanticEmbedderConfigSchema),
  vector: Schema.optional(SqliteSearchSemanticVectorConfigSchema),
  ranking: Schema.optional(SqliteSearchHybridRankingConfigSchema),
});

export type SqliteSearchProviderConfig =
  typeof SqliteSearchProviderConfigSchema.Type;
export type SqliteSearchSemanticEmbedderConfig =
  typeof SqliteSearchSemanticEmbedderConfigSchema.Type;

export type CreateSqliteSearchProviderInput =
  ExecutorSearchProviderContext<SqliteSearchProviderConfig>;

export const makeSqliteSearchEmbedderSignature = (input: {
  key: string;
  dimensions: number;
}) => `${input.key}:${input.dimensions}`;

export const resolveSqliteSearchEmbedderMetadata = (
  config?: SqliteSearchSemanticEmbedderConfig,
) => {
  if (config?.kind === "google") {
    return {
      kind: "google" as const,
      key: "google",
      dimensions: config.dimensions,
      signature: makeSqliteSearchEmbedderSignature({
        key: "google",
        dimensions: config.dimensions,
      }),
    };
  }

  const dimensions = Math.max(
    64,
    Math.floor(config?.dimensions ?? SQLITE_SEARCH_DEFAULT_HASH_DIMENSIONS),
  );

  return {
    kind: "hash-v1" as const,
    key: "hash-v1",
    dimensions,
    signature: makeSqliteSearchEmbedderSignature({
      key: "hash-v1",
      dimensions,
    }),
  };
};
