import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { RunStatus, ToolCallStatus } from "../sdk/collections";
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
