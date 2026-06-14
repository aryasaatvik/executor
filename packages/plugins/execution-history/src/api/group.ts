import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { InternalError } from "@executor-js/api";

import { InteractionRow, RunRow, RunStatus, ToolCallRow } from "../sdk/collections";

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

// --- Aggregate `meta` block (facets, stacked timeline, duration percentiles) ---

const RunStatusCount = Schema.Struct({ status: RunStatus, count: Schema.Number });
const RunTriggerCount = Schema.Struct({
  triggerKind: Schema.NullOr(Schema.String),
  count: Schema.Number,
});
const RunActorCount = Schema.Struct({
  actorId: Schema.NullOr(Schema.String),
  actorLabel: Schema.NullOr(Schema.String),
  actorKind: Schema.NullOr(Schema.String),
  count: Schema.Number,
});
const RunInteractionCounts = Schema.Struct({
  withInteraction: Schema.Number,
  withoutInteraction: Schema.Number,
});
const RunChartBucket = Schema.Struct({
  bucketStart: Schema.Number,
  // Partial status -> count map; absent statuses are omitted.
  counts: Schema.Record(Schema.String, Schema.Number),
});
const RunDurationStats = Schema.Struct({
  count: Schema.Number,
  min: Schema.NullOr(Schema.Number),
  max: Schema.NullOr(Schema.Number),
  p50: Schema.NullOr(Schema.Number),
  p75: Schema.NullOr(Schema.Number),
  p90: Schema.NullOr(Schema.Number),
  p95: Schema.NullOr(Schema.Number),
  p99: Schema.NullOr(Schema.Number),
});
export const ExecutionListMeta = Schema.Struct({
  totalRowCount: Schema.Number,
  filterRowCount: Schema.Number,
  statusCounts: Schema.Array(RunStatusCount),
  triggerCounts: Schema.Array(RunTriggerCount),
  actorCounts: Schema.Array(RunActorCount),
  interactionCounts: RunInteractionCounts,
  chartBucketMs: Schema.Number,
  chartData: Schema.Array(RunChartBucket),
  durationStats: RunDurationStats,
});

/** Keyset cursor carried opaquely on the wire as a JSON string. */
export const RunsCursor = Schema.Struct({
  sort: Schema.NullOr(Schema.Number),
  key: Schema.String,
});
export const RunsCursorFromString = Schema.fromJsonString(RunsCursor);

/** Mirrors `ExecutionHistoryListResult` from the store. */
export const ListRunsResponse = Schema.Struct({
  runs: Schema.Array(RunRow),
  nextCursor: Schema.NullOr(Schema.String),
  meta: Schema.NullOr(ExecutionListMeta),
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
// `status`/`trigger`/`actor` CSV lists stay raw strings the handler splits,
// mirroring how the store's `list` takes the matching filter arrays. The
// boolean `interaction` is carried as a string ("true"/"false") and
// interpreted in the handler — the same convention core uses for
// `includeAnnotations`/`includeBlocked`.
// ---------------------------------------------------------------------------

const ListRunsQuery = Schema.Struct({
  status: Schema.optional(Schema.String),
  trigger: Schema.optional(Schema.String),
  // CSV of actor ids (token client ids / user subjects) to filter runs by.
  actor: Schema.optional(Schema.String),
  from: Schema.optional(Schema.NumberFromString),
  to: Schema.optional(Schema.NumberFromString),
  interaction: Schema.optional(Schema.String),
  // Live-tail floor: only runs newer than this `startedAt`.
  after: Schema.optional(Schema.NumberFromString),
  sort: Schema.optional(Schema.Literals(["startedAt", "durationMs"])),
  dir: Schema.optional(Schema.Literals(["asc", "desc"])),
  limit: Schema.optional(Schema.NumberFromString),
  // Opaque keyset cursor returned as `nextCursor` from a prior page.
  cursor: Schema.optional(Schema.String),
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
