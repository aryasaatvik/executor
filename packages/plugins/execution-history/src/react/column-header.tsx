import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Button } from "@executor-js/react/components/button";
import { cn } from "@executor-js/react/lib/utils";

import type { RunsSortField } from "./use-runs-list";
import type { RunColumns } from "./view";

// ---------------------------------------------------------------------------
// RunsColumnHeader — the <thead> row. Cells are <th> with no fixed widths; the
// table's content-fit layout sizes each column to its widest cell across the
// header and all rows. Alignment matches RunListRow (short/numeric center, text
// left). `bg-background` keeps rows from bleeding through the sticky header.
// ---------------------------------------------------------------------------

const HEAD =
  "border-b border-border/60 bg-background px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 whitespace-nowrap";

interface SortButtonProps {
  readonly label: string;
  readonly field: RunsSortField;
  readonly sortField: RunsSortField;
  readonly sortDirection: "asc" | "desc";
  readonly onSort: (field: RunsSortField) => void;
}

function SortButton({ label, field, sortField, sortDirection, onSort }: SortButtonProps) {
  const isActive = sortField === field;
  const Icon = isActive ? (sortDirection === "desc" ? ArrowDown : ArrowUp) : ArrowUpDown;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => onSort(field)}
      className={cn(
        "inline-flex h-auto items-center gap-1 p-0 text-left",
        "text-[10px] font-medium uppercase tracking-wider",
        "text-muted-foreground/60 hover:bg-transparent hover:text-foreground",
        isActive && "text-foreground",
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
    <tr>
      {/* dot column (no label) */}
      <th aria-hidden scope="col" className={HEAD} />

      {/* Started (sortable, left) */}
      <th scope="col" className={cn(HEAD, "text-left")}>
        <SortButton
          label="started"
          field="startedAt"
          sortField={sortField}
          sortDirection={sortDirection}
          onSort={onSort}
        />
      </th>

      {/* Status (centered) */}
      <th scope="col" className={cn(HEAD, "text-center")}>
        status
      </th>

      {/* Trigger (left) */}
      {columns.trigger ? (
        <th scope="col" className={cn(HEAD, "text-left")}>
          trigger
        </th>
      ) : null}

      {/* Actor (left) */}
      {columns.actor ? (
        <th scope="col" className={cn(HEAD, "text-left")}>
          actor
        </th>
      ) : null}

      {/* Duration (sortable, centered) */}
      {columns.duration ? (
        <th scope="col" className={cn(HEAD, "text-center")}>
          <SortButton
            label="duration"
            field="durationMs"
            sortField={sortField}
            sortDirection={sortDirection}
            onSort={onSort}
          />
        </th>
      ) : null}

      {/* Tools (centered) */}
      {columns.tools ? (
        <th scope="col" className={cn(HEAD, "text-center")}>
          tools
        </th>
      ) : null}

      {/* Interaction (centered) */}
      {columns.interaction ? (
        <th scope="col" className={cn(HEAD, "text-center")}>
          interaction
        </th>
      ) : null}

      {/* Log (centered) */}
      {columns.log ? (
        <th scope="col" className={cn(HEAD, "text-center")}>
          log
        </th>
      ) : null}

      {/* Code (left) */}
      <th scope="col" className={cn(HEAD, "text-left")}>
        code
      </th>
    </tr>
  );
}
