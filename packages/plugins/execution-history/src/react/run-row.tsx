import { Button } from "@executor-js/react/components/button";
import { cn } from "@executor-js/react/lib/utils";
import { Badge } from "@executor-js/react/components/badge";

import type { RunRow } from "../sdk/collections";
import { formatDateTime, formatDuration, formatRelative, statusLabel } from "./format";
import { STATUS_TONES, triggerTone } from "./status";
import type { RunColumns } from "./view";

// Column slot classes — RunListRow and RunsColumnHeader both apply these
// fixed-width, same-breakpoint slots (after the dot/started/status base
// columns) so the header and rows stay aligned across screen sizes.
export const COL_TRIGGER = "hidden 2xl:block w-[120px] shrink-0";
export const COL_DURATION = "hidden md:block w-[100px] shrink-0";
export const COL_TOOLS = "hidden xl:block w-[80px] shrink-0";
export const COL_INTERACTION = "hidden xl:block w-[100px] shrink-0";

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
  const isLive = run.status === "running" || run.status === "waiting_for_interaction";

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
      <span
        title={formatDateTime(run.startedAt)}
        className="w-[150px] shrink-0 tabular-nums text-muted-foreground md:w-[190px]"
      >
        {formatRelative(run.startedAt)}
      </span>

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
        <span className={cn(COL_TRIGGER, "inline-flex gap-1")}>
          <span
            aria-hidden
            className={cn("mt-px size-1.5 shrink-0 self-center rounded-full", trigger.dot)}
          />
          <span className={trigger.text}>{trigger.label}</span>
        </span>
      ) : null}

      {/* Duration (optional) */}
      {columns.duration ? (
        <span className={cn(COL_DURATION, "tabular-nums text-muted-foreground")}>
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

      {/* Code snippet (always visible, fills remaining space) */}
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        <span className="text-muted-foreground/50">code: </span>
        <span className="text-foreground/70">
          &quot;{run.code.trim().replace(/\s+/g, " ").slice(0, 80)}&quot;
        </span>
      </span>
    </Button>
  );
}
