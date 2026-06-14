import { Effect, Schema } from "effect";

import { definePluginStorageCollection } from "@executor-js/sdk/core";

// ---------------------------------------------------------------------------
// Execution-history storage collections.
//
// Three owner-scoped plugin-storage collections back the run history: one row
// per execution (`runs`), per tool call (`toolCalls`), and per interaction
// (`interactions`). Every payload that the engine hands us as `unknown` (tool
// args/results, interaction payloads/responses, execution results/logs) is
// stored as an already-serialized JSON string in a `*Json` column so the
// indexed columns stay primitive and query-friendly. Indexes are declared so
// the read surface can filter/sort on them (the facade type-enforces that only
// declared fields appear in `where`/`orderBy`).
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
  code: Schema.String,
  resultJson: Schema.NullOr(Schema.String),
  errorText: Schema.NullOr(Schema.String),
  logsJson: Schema.NullOr(Schema.String),
  triggerKind: Schema.NullOr(Schema.String),
  triggerMetaJson: Schema.NullOr(Schema.String),
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
});
export type RunRow = typeof RunRow.Type;

export const runs = definePluginStorageCollection("runs", RunRow, {
  indexes: ["status", "triggerKind", "actorId", "startedAt", "durationMs", "hadInteraction"],
});

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

export const toolCalls = definePluginStorageCollection("toolCalls", ToolCallRow, {
  indexes: ["executionId", "startedAt"],
});

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

export const interactions = definePluginStorageCollection("interactions", InteractionRow, {
  indexes: ["executionId", "startedAt"],
});
