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

export const SqliteSearchSemanticEmbedderConfigSchema = Schema.Struct({
  kind: Schema.optional(Schema.Literal("hash-v1")),
  dimensions: Schema.optional(Schema.Number),
});

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

export type CreateSqliteSearchProviderInput =
  ExecutorSearchProviderContext<SqliteSearchProviderConfig>;
