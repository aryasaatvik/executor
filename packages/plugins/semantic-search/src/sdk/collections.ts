import { Schema } from "effect";

import { definePluginStorageCollection } from "@executor-js/sdk/core";

export const AiSearchItemStatus = Schema.Literals(["queued", "running", "completed", "error"]);
export type AiSearchItemStatus = typeof AiSearchItemStatus.Type;

export const AiSearchItemRow = Schema.Struct({
  path: Schema.String,
  key: Schema.String,
  itemId: Schema.String,
  name: Schema.String,
  description: Schema.String,
  integration: Schema.String,
  connection: Schema.optional(Schema.String),
  plugin: Schema.optional(Schema.String),
  fingerprint: Schema.String,
  status: AiSearchItemStatus,
  updatedAt: Schema.String,
  error: Schema.optional(Schema.String),
});
export type AiSearchItemRow = typeof AiSearchItemRow.Type;

export const aiSearchItems = definePluginStorageCollection("aiSearchItems", AiSearchItemRow, {
  indexes: ["path", "key", "integration", "status", "updatedAt"],
});
