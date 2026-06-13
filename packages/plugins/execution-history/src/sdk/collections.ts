import { Schema } from "effect";

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
  startedAt: Schema.Number,
  completedAt: Schema.NullOr(Schema.Number),
  durationMs: Schema.NullOr(Schema.Number),
  toolCallCount: Schema.Number,
  hadInteraction: Schema.Boolean,
});
export type RunRow = typeof RunRow.Type;

export const runs = definePluginStorageCollection("runs", RunRow, {
  indexes: ["status", "triggerKind", "startedAt", "durationMs", "hadInteraction"],
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
