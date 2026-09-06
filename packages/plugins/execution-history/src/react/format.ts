import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { RunStatus, ToolCallRow, ToolCallStatus } from "../sdk/collections";
import { STATUS_LABELS } from "./status";

// ---------------------------------------------------------------------------
// Formatting helpers shared by the runs table, drawer, and chart. Uses native
// Date + Intl (no date-fns dep). The stored `*Json` columns are already
// compact JSON strings; decode through Effect Schema (only JSON.parse is
// lint-banned — JSON.stringify is fine and won't throw on a decoded value).
// ---------------------------------------------------------------------------

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);
const decodeLogLines = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

export const prettyJson = (raw: string | null): string | null => {
  if (!raw) return null;
  return Option.match(decodeJson(raw), {
    onNone: () => raw,
    onSome: (value) => JSON.stringify(value, null, 2),
  });
};

/** The engine's `ToolResult` failure envelope: `{ ok: false, error }`. Only
 *  the fields the drawer needs; extra keys are ignored. */
const decodeFailedEnvelope = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      ok: Schema.Literal(false),
      error: Schema.Struct({ code: Schema.String, message: Schema.String }),
    }),
  ),
);

/** Effective outcome of a tool call. Rows recorded before the engine mapped
 *  `ToolResult.fail` envelopes to failed calls carry `status: "completed"` with
 *  the failure sitting in `resultJson`; derive the failure here so history
 *  reads the same for old and new rows. */
export const toolCallOutcome = (
  call: Pick<ToolCallRow, "status" | "resultJson" | "errorText">,
): { readonly status: ToolCallStatus; readonly errorText: string | null } => {
  if (call.status !== "completed" || call.resultJson === null) {
    return { status: call.status, errorText: call.errorText };
  }
  return Option.match(decodeFailedEnvelope(call.resultJson), {
    onNone: () => ({ status: call.status, errorText: call.errorText }),
    onSome: (envelope) => ({
      status: "failed",
      errorText: `${envelope.error.code}: ${envelope.error.message}`,
    }),
  });
};

/** Items the code sent through `emit()`, decoded from the stored JSON array.
 *  `content` items carry their value; `file` items carry the file reference. */
export type OutputItem =
  | { readonly type: "content"; readonly content: unknown }
  | { readonly type: "file"; readonly file: unknown };

const decodeOutputItems = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Union([
        Schema.Struct({ type: Schema.Literal("content"), content: Schema.Unknown }),
        Schema.Struct({ type: Schema.Literal("file"), file: Schema.Unknown }),
      ]),
    ),
  ),
);

/** The sandbox wraps each `emit()` value in an MCP text content block whose
 *  `text` is the JSON-encoded value (or the raw string). Unwrap that so the
 *  drawer shows what the code emitted, not the transport envelope; anything
 *  else renders as-is. */
const decodeTextBlock = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
);

export const emittedValue = (item: OutputItem): unknown => {
  if (item.type !== "content") return item.file;
  return Option.match(decodeTextBlock(item.content), {
    onNone: () => item.content,
    onSome: (block) =>
      Option.match(decodeJson(block.text), {
        onNone: () => block.text,
        onSome: (value) => value,
      }),
  });
};

export const outputItems = (raw: string | null): readonly OutputItem[] =>
  !raw
    ? []
    : Option.match(decodeOutputItems(raw), {
        onNone: () => [],
        onSome: (value) => value,
      });

export const logLines = (raw: string | null): readonly string[] =>
  !raw
    ? []
    : Option.match(decodeLogLines(raw), {
        onNone: () => [raw],
        onSome: (value) => value,
      });

export const statusLabel = (status: RunStatus | ToolCallStatus): string =>
  status in STATUS_LABELS ? STATUS_LABELS[status as RunStatus] : status;

export const formatDateTime = (timestamp: number | null): string =>
  timestamp == null ? "Pending" : new Date(timestamp).toLocaleString();

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export const formatRelative = (timestamp: number): string => {
  const delta = timestamp - Date.now();
  const abs = Math.abs(delta);
  if (abs < 60_000) return relativeFormatter.format(Math.round(delta / 1000), "second");
  if (abs < 3_600_000) return relativeFormatter.format(Math.round(delta / 60_000), "minute");
  if (abs < 86_400_000) return relativeFormatter.format(Math.round(delta / 3_600_000), "hour");
  return relativeFormatter.format(Math.round(delta / 86_400_000), "day");
};

export const formatDuration = (value: number | null): string => {
  if (value == null) return "running";
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
};
