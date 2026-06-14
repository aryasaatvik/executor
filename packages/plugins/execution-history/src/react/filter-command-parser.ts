// ---------------------------------------------------------------------------
// Pure parser for the runs filter command palette. Splits a free-text query
// into `key:value` tokens and produces a partial filter set. Adapted to the
// plugin's contract: only the 4 statuses, no tool/code/duration facets — the
// keys are status, trigger, interaction, after, and before.
//
// Parsing is forgiving by design: unknown keys, empty values, and unparsable
// dates are silently dropped (never throws). Relative durations like "1h" /
// "30m" / "7d" are resolved against `Date.now()`; absolute values fall back to
// `Date.parse` (the only allowed JSON-free epoch decode).
// ---------------------------------------------------------------------------

export interface RunsFilterTokens {
  readonly status: string[];
  readonly trigger: string[];
  readonly interaction: "true" | "false" | null;
  readonly from: number | null;
  readonly to: number | null;
}

export interface FilterKey {
  readonly key: string;
  readonly hint: string;
}

export const FILTER_KEYS: readonly FilterKey[] = [
  { key: "status", hint: "completed,failed,running,waiting" },
  { key: "trigger", hint: "mcp, http, cli, manual" },
  { key: "interaction", hint: "true | false" },
  { key: "after", hint: "1h · 30m · 7d · ISO date" },
  { key: "before", hint: "1h · 7d · ISO date" },
];

const RELATIVE_UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const RELATIVE_PATTERN = /^(\d+)([mhdw])$/;

/** Convert a relative duration token ("1h", "30m", "7d") to milliseconds, or
 *  null when it isn't a recognized relative literal. */
export const relativeToMs = (token: string): number | null => {
  const match = RELATIVE_PATTERN.exec(token.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = RELATIVE_UNIT_MS[match[2]!];
  if (unit === undefined || !Number.isFinite(amount)) return null;
  return amount * unit;
};

/** Resolve a time token to an epoch-ms instant. Relative tokens map to
 *  `now - duration`; otherwise fall back to an absolute ISO/date parse. */
const tokenToEpochMs = (value: string): number | null => {
  const relative = relativeToMs(value);
  if (relative !== null) return Date.now() - relative;
  const absolute = Date.parse(value);
  return Number.isNaN(absolute) ? null : absolute;
};

export const parseRunsFilter = (text: string): RunsFilterTokens => {
  const status: string[] = [];
  const trigger: string[] = [];
  let interaction: "true" | "false" | null = null;
  let from: number | null = null;
  let to: number | null = null;

  const parts = text.trim().split(/\s+/).filter(Boolean);

  for (const part of parts) {
    const colon = part.indexOf(":");
    if (colon <= 0) continue;
    const key = part.slice(0, colon);
    const value = part.slice(colon + 1);
    if (value.length === 0) continue;

    if (key === "status") {
      status.push(...value.split(",").filter(Boolean));
    } else if (key === "trigger") {
      trigger.push(...value.split(",").filter(Boolean));
    } else if (key === "interaction") {
      if (value === "true" || value === "false") interaction = value;
    } else if (key === "after") {
      const epoch = tokenToEpochMs(value);
      if (epoch !== null) from = epoch;
    } else if (key === "before") {
      const epoch = tokenToEpochMs(value);
      if (epoch !== null) to = epoch;
    }
    // Unknown keys are silently dropped so the input stays forgiving.
  }

  return { status, trigger, interaction, from, to };
};
