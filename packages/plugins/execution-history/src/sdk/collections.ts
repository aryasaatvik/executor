import { Effect, Schema } from "effect";

import { definePluginStorageCollection } from "@executor-js/sdk/core";

// ---------------------------------------------------------------------------
// Execution-history storage collections.
//
// ONE owner-scoped plugin-storage collection backs the run history: a slim
// `runs` row per execution carrying only the fields the list + aggregate
// surface needs (status, trigger, actor, timing, counts) plus two bounded
// denormalized fields — `codePreview` (the list's snippet) and
// `logErrorCount`/`logWarnCount` (the list's optional log column) — so the list
// renders entirely from D1 with no per-row blob fetch.
//
// The bulky, drawer-only detail (full `code`, `resultJson`, `errorText`,
// `logsJson`, `triggerMetaJson`, and the per-tool-call / per-interaction rows)
// lives in an append-only R2 object per run (see `detail-types.ts` + the store's
// `deps.blobs` writes), keeping the D1 row tiny and uncapped. `ToolCallRow` /
// `InteractionRow` remain here as the shared detail row shapes (they back the R2
// detail object and the read response), but no longer have their own collection.
// Indexes are declared so the read surface can filter/sort on them (the facade
// type-enforces that only declared fields appear in `where`/`orderBy`).
// ---------------------------------------------------------------------------

/** Terminal + transient lifecycle state of a single execution. */
export const RunStatus = Schema.Literals([
  "running",
  "waiting_for_interaction",
  "completed",
  "failed",
]);
export type RunStatus = typeof RunStatus.Type;

/** Lifecycle state of a single tool call within an execution. */
export const ToolCallStatus = Schema.Literals(["running", "completed", "failed"]);
export type ToolCallStatus = typeof ToolCallStatus.Type;

/** Lifecycle state of a single interaction (elicitation) within an execution. */
export const InteractionStatus = Schema.Literals([
  "pending",
  "accepted",
  "declined",
  "cancelled",
  "failed",
]);
export type InteractionStatus = typeof InteractionStatus.Type;

export const RunRow = Schema.Struct({
  executionId: Schema.String,
  status: RunStatus,
  // Bounded list-snippet of the code (full source lives in the R2 detail blob).
  // Normalized + truncated at write time so the list renders it directly.
  // Required: this is a breaking change with no backfill — the cutover clears
  // pre-migration rows, so every row the store writes carries these.
  codePreview: Schema.String,
  triggerKind: Schema.NullOr(Schema.String),
  // Denormalized log-line counts for the list's optional log column, so the
  // list never has to fetch + parse the full `logsJson` (now in R2).
  logErrorCount: Schema.Number,
  logWarnCount: Schema.Number,
  // Who/what the run acted as (from the trigger's `ExecutionActor`). `actorId`
  // is the STABLE filter/facet key (a token client id, a user subject);
  // `actorLabel` is the display snapshot at run time (machine name, email);
  // `actorKind` is the credential class ("user", "service-token").
  //
  // Optional-key + decoding default, NOT `NullOr`: runs are stored as JSON
  // documents, and rows written BEFORE these fields existed have no such key at
  // all. `NullOr` requires the key to be present, so a legacy doc fails the
  // response encoder ("Missing key at runs[0].actorId"). Making the key optional
  // (tolerant on the wire) while defaulting an absent key to null on decode lets
  // older docs decode/encode unchanged — and immunizes the collection against
  // the next field added the same way. The decoded type stays `string | null`
  // (always present), so every reader treats it as required.
  actorId: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  actorLabel: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  actorKind: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  startedAt: Schema.Number,
  completedAt: Schema.NullOr(Schema.Number),
  durationMs: Schema.NullOr(Schema.Number),
  toolCallCount: Schema.Number,
  hadInteraction: Schema.Boolean,
  hadFormApproval: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(false)),
  ),
  hadUrlApproval: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(false)),
  ),
});
export type RunRow = typeof RunRow.Type;

export const runs = definePluginStorageCollection("runs", RunRow, {
  indexes: [
    "status",
    "triggerKind",
    "actorId",
    "startedAt",
    "durationMs",
    "hadInteraction",
    "hadFormApproval",
    "hadUrlApproval",
  ],
});

// Per-tool-call and per-interaction detail rows. No longer their own D1
// collections — they are serialized into the run's R2 detail object (see
// `detail-types.ts`) and returned in the `get` detail response.
export const ToolCallRow = Schema.Struct({
  executionId: Schema.String,
  toolCallId: Schema.String,
  status: ToolCallStatus,
  path: Schema.String,
  namespace: Schema.NullOr(Schema.String),
  argsJson: Schema.NullOr(Schema.String),
  resultJson: Schema.NullOr(Schema.String),
  errorText: Schema.NullOr(Schema.String),
  startedAt: Schema.Number,
  completedAt: Schema.NullOr(Schema.Number),
  durationMs: Schema.NullOr(Schema.Number),
});
export type ToolCallRow = typeof ToolCallRow.Type;

export const InteractionRow = Schema.Struct({
  executionId: Schema.String,
  interactionId: Schema.String,
  status: InteractionStatus,
  kind: Schema.String,
  purpose: Schema.NullOr(Schema.String),
  payloadJson: Schema.NullOr(Schema.String),
  responseJson: Schema.NullOr(Schema.String),
  errorText: Schema.NullOr(Schema.String),
  startedAt: Schema.Number,
  completedAt: Schema.NullOr(Schema.Number),
});
export type InteractionRow = typeof InteractionRow.Type;
