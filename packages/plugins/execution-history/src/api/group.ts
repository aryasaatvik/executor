import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { InternalError } from "@executor-js/api";

import { InteractionRow, RunRow, ToolCallRow } from "../sdk/collections";

// ---------------------------------------------------------------------------
// HTTP surface for the execution-history read model.
//
// Routes are FLAT and plugin-id-prefixed (`/execution-history/...`), matching
// the onepassword/graphql convention: the per-request executor is already
// owner-scoped at the host edge, so there is no `:scopeId` path segment.
//
// Success schemas are real Effect Schemas built from the storage collection
// row schemas (`RunRow`/`ToolCallRow`/`InteractionRow`) — the store's TS
// interfaces (`ExecutionHistoryListResult`/`ExecutionHistoryDetail`) are not
// schemas and cannot encode on the wire, so the shapes are mirrored here.
//
// `InternalError` is the shared opaque 500 schema. Storage failures on the
// extension flow through the typed channel as `StorageFailure` and are
// captured + downgraded to `InternalError({ traceId })` by `capture` at the
// handler edge.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Success schemas
// ---------------------------------------------------------------------------

/** Mirrors `ExecutionHistoryListResult` from the store. */
export const ListRunsResponse = Schema.Struct({
  runs: Schema.Array(RunRow),
  total: Schema.Number,
});

/** Mirrors `ExecutionHistoryDetail` from the store. */
export const RunDetailResponse = Schema.Struct({
  run: RunRow,
  toolCalls: Schema.Array(ToolCallRow),
  interactions: Schema.Array(InteractionRow),
});

export const ListToolCallsResponse = Schema.Struct({
  toolCalls: Schema.Array(ToolCallRow),
});

// ---------------------------------------------------------------------------
// Query / path params
//
// Numeric filters arrive as strings and decode via `NumberFromString`. The
// `status`/`trigger` CSV lists stay raw strings the handler splits, mirroring
// how the store's `list` takes `statusFilter`/`triggerFilter` arrays. The
// boolean `interaction` is carried as a string ("true"/"false") and
// interpreted in the handler — the same convention core uses for
// `includeAnnotations`/`includeBlocked`.
// ---------------------------------------------------------------------------

const ListRunsQuery = Schema.Struct({
  status: Schema.optional(Schema.String),
  trigger: Schema.optional(Schema.String),
  from: Schema.optional(Schema.NumberFromString),
  to: Schema.optional(Schema.NumberFromString),
  interaction: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
  offset: Schema.optional(Schema.NumberFromString),
  sort: Schema.optional(Schema.Literals(["asc", "desc"])),
});

const RunParams = Schema.Struct({
  executionId: Schema.String,
});

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const ExecutionHistoryGroup = HttpApiGroup.make("executionHistory")
  .add(
    HttpApiEndpoint.get("list", "/execution-history/runs", {
      query: ListRunsQuery,
      success: ListRunsResponse,
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/execution-history/runs/:executionId", {
      params: RunParams,
      success: Schema.NullOr(RunDetailResponse),
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.get("listToolCalls", "/execution-history/runs/:executionId/tool-calls", {
      params: RunParams,
      success: ListToolCallsResponse,
      error: InternalError,
    }),
  );
