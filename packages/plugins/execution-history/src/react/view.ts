// ---------------------------------------------------------------------------
// Shared view-model types for the runs table (column visibility + labels).
// The sort state lives on RunsFilters (sortField/sortDirection), so there is no
// separate sort type here.
// ---------------------------------------------------------------------------

export interface RunColumns {
  readonly trigger: boolean;
  readonly actor: boolean;
  readonly duration: boolean;
  readonly tools: boolean;
  readonly interaction: boolean;
}

export type RunColumnKey = keyof RunColumns;

export const DEFAULT_COLUMNS: RunColumns = {
  trigger: true,
  actor: true,
  duration: true,
  tools: true,
  interaction: true,
};

export const RUN_COLUMN_LABELS: Record<RunColumnKey, string> = {
  trigger: "Trigger",
  actor: "Actor",
  duration: "Duration",
  tools: "Tools",
  interaction: "Interaction",
};
