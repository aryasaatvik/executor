import { Effect, Schema } from "effect";

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
  // Everything the code sent to the user through `emit()`, serialized as a
  // JSON array of `{ type: "content" | "file", ... }` items. Optional-key with
  // a decoding default so detail objects written before the field existed
  // still decode (see the `actor*` note on `RunRow`).
  outputJson: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  errorText: Schema.NullOr(Schema.String),
  logsJson: Schema.NullOr(Schema.String),
  triggerMetaJson: Schema.NullOr(Schema.String),
  toolCalls: Schema.Array(ToolCallRow),
  interactions: Schema.Array(InteractionRow),
});
export type RunDetail = typeof RunDetail.Type;

/** Codec between the R2 blob's JSON string and a typed {@link RunDetail}. */
export const RunDetailFromJsonString = Schema.fromJsonString(RunDetail);
