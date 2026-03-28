import { Schema } from "effect";

import {
  TimestampMsSchema,
  SourceCatalogIdSchema,
  SourceCatalogRevisionIdSchema,
} from "./ids";

export const SourceCatalogKindSchema = Schema.Literal(
  "imported",
  "internal",
);

export const SourceCatalogAdapterKeySchema = Schema.String;

export const SourceCatalogVisibilitySchema = Schema.Literal(
  "private",
  "workspace",
  "organization",
  "public",
);

export const StoredSourceCatalogRecordSchema = Schema.Struct({
  id: SourceCatalogIdSchema,
  kind: SourceCatalogKindSchema,
  adapterKey: SourceCatalogAdapterKeySchema,
  providerKey: Schema.String,
  name: Schema.String,
  summary: Schema.NullOr(Schema.String),
  visibility: SourceCatalogVisibilitySchema,
  latestRevisionId: SourceCatalogRevisionIdSchema,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export const StoredSourceCatalogRevisionRecordSchema = Schema.Struct({
  id: SourceCatalogRevisionIdSchema,
  catalogId: SourceCatalogIdSchema,
  revisionNumber: Schema.Number,
  sourceConfigJson: Schema.String,
  importMetadataJson: Schema.NullOr(Schema.String),
  importMetadataHash: Schema.NullOr(Schema.String),
  snapshotHash: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export const ToolSearchModeSchema = Schema.Literal("exact", "search");

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

export type SourceCatalogKind = typeof SourceCatalogKindSchema.Type;
export type SourceCatalogAdapterKey = typeof SourceCatalogAdapterKeySchema.Type;
export type SourceCatalogVisibility = typeof SourceCatalogVisibilitySchema.Type;
export type StoredSourceCatalogRecord = typeof StoredSourceCatalogRecordSchema.Type;
export type StoredSourceCatalogRevisionRecord = typeof StoredSourceCatalogRevisionRecordSchema.Type;
export type ToolSearchMode = typeof ToolSearchModeSchema.Type;
export type ToolSearchBackendMode = typeof ToolSearchBackendModeSchema.Type;
export type ToolSearchResult = typeof ToolSearchResultSchema.Type;
export type ToolSearchMeta = typeof ToolSearchMetaSchema.Type;
export type ToolSearchPayload = typeof ToolSearchPayloadSchema.Type;
export type ToolSearchResultSet = typeof ToolSearchResultSetSchema.Type;
