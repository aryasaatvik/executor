import {
  Schema,
} from "effect";

import {
  ToolContractSchema,
} from "@executor/codemode-core";

export const SearchProviderInfoSchema = Schema.Struct({
  providerKey: Schema.String,
  mode: Schema.String,
  backend: Schema.String,
  fallbackUsed: Schema.optional(Schema.Boolean),
});

export const SearchProviderStatusSchema = Schema.extend(
  SearchProviderInfoSchema,
  Schema.Struct({
    configuredProviderKey: Schema.String,
    healthy: Schema.Boolean,
    detail: Schema.optional(Schema.String),
    sourceCount: Schema.optional(Schema.Number),
    documentCount: Schema.optional(Schema.Number),
    staleSourceCount: Schema.optional(Schema.Number),
  }),
);

export const SearchResultItemSchema = Schema.Struct({
  path: Schema.String,
  score: Schema.Number,
  sourceKey: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  interaction: Schema.optional(
    Schema.Union(Schema.Literal("auto"), Schema.Literal("required")),
  ),
  contract: Schema.optional(ToolContractSchema),
  metadata: Schema.optional(Schema.Record({
    key: Schema.String,
    value: Schema.Unknown,
  })),
});

export const SearchResultSchema = Schema.Struct({
  provider: SearchProviderInfoSchema,
  bestPath: Schema.NullOr(Schema.String),
  total: Schema.Number,
  results: Schema.Array(SearchResultItemSchema),
});

export type SearchProviderInfo = typeof SearchProviderInfoSchema.Type;
export type SearchProviderStatus = typeof SearchProviderStatusSchema.Type;
export type SearchResultItem = typeof SearchResultItemSchema.Type;
export type SearchResult = typeof SearchResultSchema.Type;
