import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Button } from "@executor-js/react/components/button";
import { cn } from "@executor-js/react/lib/utils";

import type { RunsSortField } from "./use-runs-list";
import type { RunColumns } from "./view";
import { COL_DURATION, COL_INTERACTION, COL_TOOLS, COL_TRIGGER } from "./run-row";

// ---------------------------------------------------------------------------
// RunsColumnHeader — sticky header row aligned to RunListRow's layout.
// Imports the shared column slot classes from run-row so that header and rows
// use the same widths and breakpoints.
// ---------------------------------------------------------------------------

interface SortButtonProps {
  readonly label: string;
  readonly field: RunsSortField;
  readonly sortField: RunsSortField;
  readonly sortDirection: "asc" | "desc";
  readonly onSort: (field: RunsSortField) => void;
  readonly className?: string;
}

function SortButton({
  label,
  field,
  sortField,
  sortDirection,
  onSort,
  className,
}: SortButtonProps) {
  const isActive = sortField === field;
  const Icon = isActive ? (sortDirection === "desc" ? ArrowDown : ArrowUp) : ArrowUpDown;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => onSort(field)}
      className={cn(
        "h-auto p-0 inline-flex items-center gap-1 text-left",
        "text-[10px] font-medium uppercase tracking-wider",
        "text-muted-foreground/60 hover:text-foreground hover:bg-transparent",
        isActive && "text-foreground",
        className,
      )}
    >
      <span>{label}</span>
      <Icon className={cn("size-3 shrink-0", !isActive && "opacity-40")} />
    </Button>
  );
}

export interface RunsColumnHeaderProps {
  readonly sortField: RunsSortField;
  readonly sortDirection: "asc" | "desc";
  readonly onSort: (field: RunsSortField) => void;
  readonly columns: RunColumns;
}

export function RunsColumnHeader({
  sortField,
  sortDirection,
  onSort,
  columns,
}: RunsColumnHeaderProps) {
  return (
    <div className="flex min-w-0 items-center gap-2 overflow-hidden px-4 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
      {/* dot spacer */}
      <span aria-hidden className="size-2 shrink-0" />

      {/* Started (sortable) */}
      <SortButton
        label="started"
        field="startedAt"
        sortField={sortField}
        sortDirection={sortDirection}
        onSort={onSort}
        className="w-[150px] shrink-0 md:w-[190px]"
      />

      {/* Status */}
      <span className="w-[120px] shrink-0">status</span>

      {/* Trigger */}
      {columns.trigger ? <span className={COL_TRIGGER}>trigger</span> : null}

      {/* Duration (sortable) */}
      {columns.duration ? (
        <SortButton
          label="duration"
          field="durationMs"
          sortField={sortField}
          sortDirection={sortDirection}
          onSort={onSort}
          className={COL_DURATION}
        />
      ) : null}

      {/* Tools */}
      {columns.tools ? <span className={COL_TOOLS}>tools</span> : null}

      {/* Interaction */}
      {columns.interaction ? <span className={COL_INTERACTION}>interaction</span> : null}

      {/* Code */}
      <span className="min-w-0 flex-1 truncate">code</span>
    </div>
  );
}
