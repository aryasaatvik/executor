import type { RunStatus } from "../sdk/collections";

// ---------------------------------------------------------------------------
// Status + trigger presentation constants (no JSX) shared across the runs UI.
// The plugin's RunStatus is the 4-value lifecycle (running /
// waiting_for_interaction / completed / failed) — the inline prototype's
// pending/cancelled states don't exist in this data model.
// ---------------------------------------------------------------------------

/** Canonical render order (most "settled" first) for facets + chart stacking. */
export const STATUS_ORDER: readonly RunStatus[] = [
  "completed",
  "running",
  "waiting_for_interaction",
  "failed",
];

export const STATUS_LABELS: Record<RunStatus, string> = {
  running: "running",
  waiting_for_interaction: "waiting",
  completed: "completed",
  failed: "failed",
};

export interface StatusTone {
  /** Background class for the status dot. */
  readonly dot: string;
  /** Foreground text class. */
  readonly text: string;
  /** Border/bg/text classes for an outline badge. */
  readonly badge: string;
  /** Whether the dot should pulse (transient states). */
  readonly pulse: boolean;
}

export const STATUS_TONES: Record<RunStatus, StatusTone> = {
  completed: {
    dot: "bg-emerald-500",
    text: "text-emerald-600 dark:text-emerald-300",
    badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    pulse: false,
  },
  running: {
    dot: "bg-sky-500",
    text: "text-sky-600 dark:text-sky-300",
    badge: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    pulse: true,
  },
  waiting_for_interaction: {
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-300",
    badge: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    pulse: true,
  },
  failed: {
    dot: "bg-destructive",
    text: "text-destructive",
    badge: "border-destructive/30 bg-destructive/10 text-destructive",
    pulse: false,
  },
};

export const statusTone = (status: RunStatus): StatusTone => STATUS_TONES[status];

/** Literal hex fills for the recharts stacked timeline (one series per status). */
export const STATUS_CHART_HEX: Record<RunStatus, string> = {
  completed: "#10b981",
  running: "#0ea5e9",
  waiting_for_interaction: "#f59e0b",
  failed: "#ef4444",
};

export interface TriggerTone {
  readonly dot: string;
  readonly text: string;
  readonly label: string;
}

export const TRIGGER_TONES: Record<string, TriggerTone> = {
  mcp: { dot: "bg-violet-500", text: "text-violet-600 dark:text-violet-300", label: "MCP" },
  http: { dot: "bg-cyan-500", text: "text-cyan-600 dark:text-cyan-300", label: "HTTP" },
  cli: { dot: "bg-slate-500", text: "text-slate-600 dark:text-slate-300", label: "CLI" },
  manual: { dot: "bg-slate-500", text: "text-slate-600 dark:text-slate-300", label: "manual" },
};

export const TRIGGER_ORDER: readonly string[] = ["mcp", "http", "cli", "manual"];

export const triggerTone = (kind: string | null | undefined): TriggerTone => {
  if (kind != null) {
    const known = TRIGGER_TONES[kind];
    if (known) return known;
    return { dot: "bg-muted-foreground/40", text: "text-muted-foreground", label: kind };
  }
  return { dot: "bg-muted-foreground/40", text: "text-muted-foreground", label: "unknown" };
};

// ---------------------------------------------------------------------------
// Actor tones — colour the dot in the Actor facet/column by credential class
// (`actorKind`: "user", "service-token", …). The label itself is the actor's
// own display string (machine name, email), not a fixed vocabulary, so there is
// no ACTOR_ORDER — facet keys come from `meta.actorCounts`.
// ---------------------------------------------------------------------------

export interface ActorTone {
  readonly dot: string;
  readonly text: string;
}

export const ACTOR_TONES: Record<string, ActorTone> = {
  user: { dot: "bg-sky-500", text: "text-foreground/80" },
  "service-token": { dot: "bg-violet-500", text: "text-foreground/80" },
};

export const actorTone = (kind: string | null | undefined): ActorTone => {
  if (kind != null) {
    const known = ACTOR_TONES[kind];
    if (known) return known;
  }
  return { dot: "bg-muted-foreground/40", text: "text-muted-foreground" };
};
