import { Button } from "@executor-js/react/components/button";
import { cn } from "@executor-js/react/lib/utils";
import { Badge } from "@executor-js/react/components/badge";

import type { RunRow } from "../sdk/collections";
import { formatDuration, formatRelative, statusLabel } from "./format";
import { actorTone, STATUS_TONES, triggerTone } from "./status";
import { HoverCardTimestamp } from "./hover-card-timestamp";
import type { RunColumns } from "./view";

// Column slot classes — RunListRow and RunsColumnHeader both apply these
// fixed-width slots (after the dot/started/status base columns) so the header
// and rows stay pixel-aligned. Every column is always rendered; when the
// viewport is narrower than the table's natural width the body scrolls
// horizontally (see RunsShell's min-width wrapper) instead of hiding columns.
//
// Trigger/duration/actor carry inline content (a dot+label, a sort button), so
// their display must be `flex` — composing `block` with an element's own
// `inline-flex` makes tailwind-merge collapse to one display value, which
// silently desyncs the header slot from the row slot (trigger) or wraps the
// sort label onto a second line (duration). A `flex` slot keeps both in lockstep.
export const COL_TRIGGER = "flex w-[120px] shrink-0";
export const COL_ACTOR = "flex w-[170px] shrink-0";
export const COL_DURATION = "flex w-[100px] shrink-0";
export const COL_TOOLS = "block w-[80px] shrink-0";
export const COL_INTERACTION = "block w-[100px] shrink-0";
export const COL_LOG = "block w-[80px] shrink-0";

export interface RunListRowProps {
  readonly run: RunRow;
  readonly selected: boolean;
  readonly isPast: boolean;
  readonly columns: RunColumns;
  readonly onSelect: () => void;
}

export function RunListRow({ run, selected, isPast, columns, onSelect }: RunListRowProps) {
  const tone = STATUS_TONES[run.status];
  const trigger = triggerTone(run.triggerKind);
  const actor = actorTone(run.actorKind);
  const isLive = run.status === "running" || run.status === "waiting_for_interaction";
  // Log error/warn counts are denormalized onto the slim row at write time, so
  // the list never fetches/parses the full logs (now in the R2 detail object).
  // `?? 0` covers pre-migration rows whose optional keys decode to undefined.
  const logErrors = run.logErrorCount ?? 0;
  const logWarns = run.logWarnCount ?? 0;

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onSelect}
      className={cn(
        "group h-auto w-full justify-start",
        "flex min-w-0 items-center gap-2 overflow-hidden border-b border-border/40 px-4 py-2",
        "text-left font-mono text-xs transition-colors",
        "hover:bg-foreground/[0.03]",
        selected && "bg-foreground/[0.05] hover:bg-foreground/[0.05]",
        isPast && "opacity-50",
      )}
    >
      {/* Status dot */}
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full", tone.dot, tone.pulse && "animate-pulse")}
      />

      {/* Started */}
      <HoverCardTimestamp
        timestamp={run.startedAt}
        display={formatRelative(run.startedAt)}
        className="w-[180px] shrink-0 tabular-nums text-muted-foreground"
      />

      {/* Status label */}
      <span className={cn("inline-flex w-[120px] shrink-0 gap-1", tone.text)}>
        {statusLabel(run.status)}
        {isLive && (
          <span className="text-muted-foreground/50">
            {run.status === "waiting_for_interaction" ? " ·" : ""}
          </span>
        )}
      </span>

      {/* Trigger (optional) */}
      {columns.trigger ? (
        <span className={cn(COL_TRIGGER, "items-center gap-1")}>
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", trigger.dot)} />
          <span className={cn("truncate", trigger.text)}>{trigger.label}</span>
        </span>
      ) : null}

      {/* Actor (optional) */}
      {columns.actor ? (
        <span className={cn(COL_ACTOR, "items-center gap-1")}>
          {run.actorId !== null ? (
            <>
              <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", actor.dot)} />
              <span
                className={cn("truncate", actor.text)}
                title={run.actorLabel ?? run.actorId ?? undefined}
              >
                {run.actorLabel ?? run.actorId}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground/50">—</span>
          )}
        </span>
      ) : null}

      {/* Duration (optional) — slow runs (>5s) flagged. */}
      {columns.duration ? (
        <span
          className={cn(
            COL_DURATION,
            "tabular-nums",
            run.durationMs != null && run.durationMs > 5000
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {formatDuration(run.durationMs)}
        </span>
      ) : null}

      {/* Tool call count (optional) */}
      {columns.tools ? (
        <span
          className={cn(
            COL_TOOLS,
            "tabular-nums",
            run.toolCallCount > 0 ? "text-foreground/80" : "text-muted-foreground/60",
          )}
        >
          {run.toolCallCount}
        </span>
      ) : null}

      {/* Interaction (optional) */}
      {columns.interaction ? (
        <span className={cn(COL_INTERACTION)}>
          {run.hadInteraction ? (
            <Badge
              variant="outline"
              className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
            >
              yes
            </Badge>
          ) : (
            <span className="text-muted-foreground/50">—</span>
          )}
        </span>
      ) : null}

      {/* Log error/warn counts (optional) */}
      {columns.log ? (
        <span className={cn(COL_LOG, "tabular-nums")}>
          {logErrors === 0 && logWarns === 0 ? (
            <span className="text-muted-foreground/50">—</span>
          ) : (
            <span className="inline-flex gap-1.5">
              <span className={logErrors > 0 ? "text-destructive" : "text-muted-foreground/60"}>
                {logErrors}E
              </span>
              <span
                className={
                  logWarns > 0 ? "text-amber-600 dark:text-amber-300" : "text-muted-foreground/60"
                }
              >
                {logWarns}W
              </span>
            </span>
          )}
        </span>
      ) : null}

      {/* Code preview (always visible, fills remaining space). Pre-normalized at
          write time; sliced here only to bound the rendered width. */}
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        <span className="text-muted-foreground/50">code: </span>
        <span className="text-foreground/70">
          &quot;{(run.codePreview ?? "").slice(0, 160)}&quot;
        </span>
      </span>
    </Button>
  );
}
