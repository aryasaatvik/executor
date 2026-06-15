import { Schema } from "effect";

import { InteractionRow, ToolCallRow } from "./collections";

// ---------------------------------------------------------------------------
// Run detail — the append-only R2 object written once per finished execution
// (and as a code-only stub on start). Holds the bulky, drawer-only payload that
// used to live in the fat `runs` row + the `toolCalls`/`interactions`
// collections: full code, the serialized result/error/logs/trigger-metadata,
// and the per-tool-call / per-interaction rows.
//
// Serialized to/from a JSON string at the blob boundary via Effect Schema
// (`Schema.fromJsonString`) — never raw `JSON.parse`/`JSON.stringify`. The
// `*Json` fields are already JSON strings (the store pre-serializes each
// `unknown` payload), so they round-trip as escaped strings the drawer parses.
// ---------------------------------------------------------------------------

export const RunDetail = Schema.Struct({
  code: Schema.String,
  resultJson: Schema.NullOr(Schema.String),
  errorText: Schema.NullOr(Schema.String),
  logsJson: Schema.NullOr(Schema.String),
  triggerMetaJson: Schema.NullOr(Schema.String),
  toolCalls: Schema.Array(ToolCallRow),
  interactions: Schema.Array(InteractionRow),
});
export type RunDetail = typeof RunDetail.Type;

/** Codec between the R2 blob's JSON string and a typed {@link RunDetail}. */
export const RunDetailFromJsonString = Schema.fromJsonString(RunDetail);
