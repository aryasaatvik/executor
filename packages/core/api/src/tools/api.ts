// ---------------------------------------------------------------------------
// Tools HTTP API — the v2 catalog read surface.
//
// Tools are per-connection and address-keyed
// (`tools.<integration>.<owner>.<connection>.<tool>`). `list` returns the
// persisted tool rows filtered by an optional `ToolListFilter`; `schema`
// returns the full schema view for one address. The branded `ToolAddress` is a
// dotted string, so it is carried as a query param, not a path segment.
// ---------------------------------------------------------------------------

import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import {
  ConnectionName,
  IntegrationSlug,
  InternalError,
  Owner,
  ToolAddress,
  ToolNotFoundError,
  ToolSchemaEntry,
  ToolSchemaView,
} from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const ToolMetadataResponse = Schema.Struct({
  address: ToolAddress,
  owner: Owner,
  integration: IntegrationSlug,
  connection: ConnectionName,
  name: Schema.String,
  pluginId: Schema.String,
  description: Schema.String,
  mayElicit: Schema.optional(Schema.Boolean),
  /** Plugin-derived default approval annotation. Surfaces in the UI as the
   *  "default" policy when no user `tool_policy` rule matches. */
  requiresApproval: Schema.optional(Schema.Boolean),
  approvalDescription: Schema.optional(Schema.String),
  static: Schema.optional(Schema.Boolean),
});

// ---------------------------------------------------------------------------
// Query — `tools.list` filters (mirrors `ToolListFilter`).
// ---------------------------------------------------------------------------

const ListToolsQuery = Schema.Struct({
  integration: Schema.optional(IntegrationSlug),
  owner: Schema.optional(Owner),
  connection: Schema.optional(ConnectionName),
  query: Schema.optional(Schema.String),
  // Query params arrive as strings; the handler interprets "true"/"false".
  includeAnnotations: Schema.optional(Schema.String),
  includeBlocked: Schema.optional(Schema.String),
});

const SchemaQuery = Schema.Struct({
  address: ToolAddress,
});

// Bulk schema reads reuse `tools.list`'s filters and add keyset paging.
// `limit` and `includeBlocked` arrive as strings; the handler parses them.
const ListToolSchemasQuery = Schema.Struct({
  integration: Schema.optional(IntegrationSlug),
  owner: Schema.optional(Owner),
  connection: Schema.optional(ConnectionName),
  includeBlocked: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.String),
  after: Schema.optional(Schema.String),
});

// ---------------------------------------------------------------------------
// Error schemas with HTTP status annotations
// ---------------------------------------------------------------------------

const ToolNotFound = ToolNotFoundError.annotate({ httpApiStatus: 404 });

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const ToolsApi = HttpApiGroup.make("tools")
  .add(
    HttpApiEndpoint.get("list", "/tools", {
      query: ListToolsQuery,
      success: Schema.Array(ToolMetadataResponse),
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.get("schema", "/tools/schema", {
      query: SchemaQuery,
      success: ToolSchemaView,
      error: [InternalError, ToolNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.get("listSchemas", "/tools/schemas", {
      query: ListToolSchemasQuery,
      success: Schema.Array(ToolSchemaEntry),
      error: InternalError,
    }),
  );
