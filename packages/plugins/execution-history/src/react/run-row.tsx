import { cn } from "@executor-js/react/lib/utils";
import { Badge } from "@executor-js/react/components/badge";

import type { RunRow } from "../sdk/collections";
import { formatDuration, formatRelative, statusLabel } from "./format";
import { actorTone, STATUS_TONES, triggerTone } from "./status";
import { HoverCardTimestamp } from "./hover-card-timestamp";
import type { RunColumns } from "./view";

// One semantic <table> row per run. Columns are content-fit — widths come from
// the browser's `table-layout: auto` over all rows + the header (see RunsShell),
// so there are no fixed column widths. Short / numeric / badge columns center;
// text columns left-align. The two columns that can run long — `actor` (a token
// id / email) and `code` — are width-capped and truncated (hover shows the full
// value) so content-fit can't blow the table out.
const CELL = "border-b border-border/40 px-3 py-2 align-middle whitespace-nowrap";

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
  const logErrors = run.logErrorCount;
  const logWarns = run.logWarnCount;

  return (
    <tr
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group cursor-pointer font-mono text-xs outline-none transition-colors",
        "hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.05]",
        selected && "bg-foreground/[0.05] hover:bg-foreground/[0.05]",
        isPast && "opacity-50",
      )}
    >
      {/* Status dot (centered) */}
      <td className={cn(CELL, "text-center")}>
        <span
          aria-hidden
          className={cn(
            "inline-block size-2 rounded-full align-middle",
            tone.dot,
            tone.pulse && "animate-pulse",
          )}
        />
      </td>

      {/* Started (left) */}
      <td className={cn(CELL, "text-left tabular-nums text-muted-foreground")}>
        <HoverCardTimestamp timestamp={run.startedAt} display={formatRelative(run.startedAt)} />
      </td>

      {/* Status (centered) */}
      <td className={cn(CELL, "text-center", tone.text)}>
        {statusLabel(run.status)}
        {isLive && run.status === "waiting_for_interaction" ? (
          <span className="text-muted-foreground/50"> ·</span>
        ) : null}
      </td>

      {/* Trigger (left, optional) */}
      {columns.trigger ? (
        <td className={cn(CELL, "text-left")}>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", trigger.dot)} />
            <span className={trigger.text}>{trigger.label}</span>
          </span>
        </td>
      ) : null}

      {/* Actor (left, capped + truncated, optional) */}
      {columns.actor ? (
        <td className={cn(CELL, "max-w-[160px] text-left")}>
          {run.actorId !== null ? (
            <span className="flex items-center gap-1">
              <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", actor.dot)} />
              <span
                className={cn("min-w-0 truncate", actor.text)}
                title={run.actorLabel ?? run.actorId ?? undefined}
              >
                {run.actorLabel ?? run.actorId}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground/50">—</span>
          )}
        </td>
      ) : null}

      {/* Duration (centered, optional) — slow runs (>5s) flagged */}
      {columns.duration ? (
        <td
          className={cn(
            CELL,
            "text-center tabular-nums",
            run.durationMs != null && run.durationMs > 5000
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {formatDuration(run.durationMs)}
        </td>
      ) : null}

      {/* Tool call count (centered, optional) */}
      {columns.tools ? (
        <td
          className={cn(
            CELL,
            "text-center tabular-nums",
            run.toolCallCount > 0 ? "text-foreground/80" : "text-muted-foreground/60",
          )}
        >
          {run.toolCallCount}
        </td>
      ) : null}

      {/* Interaction (centered, optional) */}
      {columns.interaction ? (
        <td className={cn(CELL, "text-center")}>
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
        </td>
      ) : null}

      {/* Log error/warn counts (centered, optional) */}
      {columns.log ? (
        <td className={cn(CELL, "text-center tabular-nums")}>
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
        </td>
      ) : null}

      {/* Code preview (left, capped + truncated; hover reveals the full
          write-bounded preview) */}
      <td
        className={cn(CELL, "max-w-[320px] truncate text-left text-muted-foreground")}
        title={run.codePreview}
      >
        <span className="text-muted-foreground/50">code: </span>
        <span className="text-foreground/70">&quot;{run.codePreview}&quot;</span>
      </td>
    </tr>
  );
}
