import { Schema } from "effect";

export const ToolSearchModeSchema = Schema.Literal(
  "exact",
  "search",
);

export const ToolSearchBackendModeSchema = Schema.Literal(
  "fts",
  "semantic",
  "hybrid",
);

export const ToolSearchResultSchema = Schema.Struct({
  path: Schema.String,
  score: Schema.Number,
  sourceKey: Schema.String,
  namespace: Schema.String,
  description: Schema.optional(Schema.String),
  inputTypePreview: Schema.optional(Schema.String),
  outputTypePreview: Schema.optional(Schema.String),
});

export const ToolSearchMetaSchema = Schema.Struct({
  query: Schema.String,
  mode: ToolSearchModeSchema,
  searchMode: ToolSearchBackendModeSchema,
  total: Schema.Number,
  source: Schema.NullOr(Schema.String),
  namespace: Schema.NullOr(Schema.String),
  limit: Schema.Number,
});

export const ToolSearchPayloadSchema = Schema.Struct({
  query: Schema.String,
  source: Schema.optional(Schema.NullOr(Schema.String)),
  namespace: Schema.optional(Schema.NullOr(Schema.String)),
  limit: Schema.optional(Schema.Number),
});

export const ToolSearchResultSetSchema = Schema.Struct({
  meta: ToolSearchMetaSchema,
  results: Schema.Array(ToolSearchResultSchema),
});

export type ToolSearchMode = typeof ToolSearchModeSchema.Type;
export type ToolSearchBackendMode = typeof ToolSearchBackendModeSchema.Type;
export type ToolSearchResult = typeof ToolSearchResultSchema.Type;
export type ToolSearchMeta = typeof ToolSearchMetaSchema.Type;
export type ToolSearchPayload = typeof ToolSearchPayloadSchema.Type;
export type ToolSearchResultSet = typeof ToolSearchResultSetSchema.Type;
