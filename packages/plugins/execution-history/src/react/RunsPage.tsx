import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@executor-js/react/components/button";

import { RunsColumnHeader } from "./column-header";
import { DetailDrawer } from "./detail-drawer";
import { RunsFilterCommand } from "./filter-command";
import { RunsFilterRail } from "./filter-rail";
import { KeyboardHelp } from "./keyboard-help";
import { LiveButton } from "./live-button";
import { LiveDivider } from "./live-row";
import { RefreshButton } from "./refresh-button";
import { RunListRow } from "./run-row";
import { RunsShell } from "./shell";
import { RunsTimelineChart } from "./timeline-chart";
import {
  emptyRunsFilters,
  useRunsList,
  type RunsFilters,
  type RunsListView,
  type RunsSortField,
} from "./use-runs-list";
import { DEFAULT_COLUMNS, type RunColumnKey, type RunColumns } from "./view";
import { ViewOptions } from "./view-options";

// ---------------------------------------------------------------------------
// Execution-history runs page — openstatus-style.
//
// A faceted filter rail, a stacked-by-status timeline, a cmdk filter palette,
// live tailing, keyset infinite scroll, sortable columns, and a 3-tab detail
// drawer. All list data + accumulation flows through `useRunsList` (atoms);
// this component is filter/UI state + composition only.
// ---------------------------------------------------------------------------

interface ShortcutContext {
  readonly view: RunsListView;
  readonly selected: string | null;
}

const COLUMNS_STORAGE_KEY = "executionHistory.columns";

// Column visibility persists across reloads as a comma-joined list of the
// visible keys (avoids JSON.parse, which the repo lints against). Keys absent
// from the stored list — including columns added in a later release — read as
// hidden, falling back to DEFAULT_COLUMNS only when nothing is stored.
const readStoredColumns = (): RunColumns => {
  if (typeof window === "undefined") return DEFAULT_COLUMNS;
  const raw = window.localStorage.getItem(COLUMNS_STORAGE_KEY);
  if (raw == null) return DEFAULT_COLUMNS;
  const visible = new Set(raw.split(",").filter(Boolean));
  const next = { ...DEFAULT_COLUMNS };
  for (const key of Object.keys(next) as RunColumnKey[]) {
    next[key] = visible.has(key);
  }
  return next;
};

export function RunsPage() {
  const [filters, setFilters] = useState<RunsFilters>(emptyRunsFilters);
  const [live, setLive] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [columns, setColumns] = useState<RunColumns>(readStoredColumns);
  const [commandOpen, setCommandOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const commandInputRef = useRef<HTMLInputElement>(null);

  const view = useRunsList(filters, live);

  const onSort = useCallback((field: RunsSortField) => {
    setFilters((current) =>
      current.sortField === field
        ? { ...current, sortDirection: current.sortDirection === "asc" ? "desc" : "asc" }
        : { ...current, sortField: field, sortDirection: "desc" },
    );
  }, []);

  const toggleColumn = useCallback((key: RunColumnKey) => {
    setColumns((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const visible = (Object.keys(columns) as RunColumnKey[]).filter((key) => columns[key]);
    window.localStorage.setItem(COLUMNS_STORAGE_KEY, visible.join(","));
  }, [columns]);

  // Keep the latest view/selected reachable from a stable keydown listener.
  const shortcutRef = useRef<ShortcutContext>({ view, selected });
  shortcutRef.current = { view, selected };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target != null &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      if (event.key === "/" && !typing) {
        event.preventDefault();
        setCommandOpen(true);
        requestAnimationFrame(() => commandInputRef.current?.focus());
        return;
      }
      if (event.key === "Escape") {
        setCommandOpen(false);
        return;
      }
      if (typing) return;

      const { view: latestView, selected: latestSelected } = shortcutRef.current;
      if (event.key === "j") {
        setLive((value) => !value);
      } else if (event.key === "r") {
        latestView.refresh();
      } else if (event.key === "?") {
        setHelpOpen((value) => !value);
      } else if (event.key === "b") {
        setRailCollapsed((value) => !value);
      } else if (latestSelected != null && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        const ids = latestView.rows.map((run) => run.executionId);
        const index = ids.indexOf(latestSelected);
        if (index < 0) return;
        const nextId = event.key === "ArrowUp" ? ids[index - 1] : ids[index + 1];
        if (nextId != null) setSelected(nextId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // The live divider + isPast styling assume newest-first ordering. For
  // ascending sort live rows append at the bottom with no divider, so only
  // compute the cutoff for descending sort.
  const isDescending = filters.sortDirection !== "asc";
  const cutoffIndex = useMemo(
    () =>
      !isDescending || view.liveCutoffId == null
        ? -1
        : view.rows.findIndex((run) => run.executionId === view.liveCutoffId),
    [isDescending, view.rows, view.liveCutoffId],
  );

  const rowItems: React.ReactNode[] = [];
  view.rows.forEach((run, index) => {
    if (index === cutoffIndex && cutoffIndex > 0) {
      rowItems.push(<LiveDivider key="live-divider" />);
    }
    rowItems.push(
      <RunListRow
        key={run.executionId}
        run={run}
        selected={run.executionId === selected}
        isPast={cutoffIndex > 0 && index >= cutoffIndex}
        columns={columns}
        onSelect={() => setSelected(run.executionId)}
      />,
    );
  });

  if (view.isLoadMoreError) {
    rowItems.push(
      <div
        key="load-more-error"
        className="flex w-full flex-col items-center justify-center gap-2 border-t border-border/50 py-4 text-center"
      >
        <p className="font-mono text-xs text-destructive">Failed to load more</p>
        <Button type="button" variant="outline" size="sm" onClick={view.retry}>
          Retry
        </Button>
      </div>,
    );
  }

  const toolbar = (
    <div className="flex flex-col gap-2 px-4 py-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-sm font-semibold">Runs</h1>
          {view.meta != null && (
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground/70">
              {view.rows.length} of {view.meta.filterRowCount}
            </span>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-muted-foreground"
            onClick={() => setCommandOpen((value) => !value)}
          >
            Filter…
            <span className="ml-2 rounded border border-border px-1 font-mono text-[10px]">/</span>
          </Button>
        </div>
        <div className="flex items-center gap-1.5">
          <LiveButton active={live} onToggle={() => setLive((value) => !value)} />
          <RefreshButton onClick={view.refresh} isLoading={view.isLoading || view.isLoadingMore} />
          <ViewOptions columns={columns} onToggle={toggleColumn} />
          <KeyboardHelp open={helpOpen} onOpenChange={setHelpOpen} />
        </div>
      </div>
      <RunsFilterCommand
        ref={commandInputRef}
        filters={filters}
        meta={view.meta}
        onApply={setFilters}
        open={commandOpen}
        onOpenChange={setCommandOpen}
      />
    </div>
  );

  const chart =
    view.meta != null && view.meta.chartData.length > 0 ? (
      <RunsTimelineChart
        data={view.meta.chartData}
        bucketMs={view.meta.chartBucketMs}
        onRangeSelect={({ from, to }) => setFilters((current) => ({ ...current, from, to }))}
      />
    ) : undefined;

  const body = view.isLoading ? (
    <div className="p-6 text-sm text-muted-foreground">Loading runs…</div>
  ) : view.isError ? (
    <div className="p-6 text-sm text-destructive">Unable to load runs.</div>
  ) : (
    rowItems
  );

  // Prev/next drawer navigation mirrors the ArrowUp/ArrowDown keyboard handler:
  // index-1 is the row above (newer in descending sort), index+1 the row below.
  const selectedIndex =
    selected == null ? -1 : view.rows.findIndex((run) => run.executionId === selected);
  const prevId = selectedIndex > 0 ? (view.rows[selectedIndex - 1]?.executionId ?? null) : null;
  const nextId =
    selectedIndex >= 0 && selectedIndex < view.rows.length - 1
      ? (view.rows[selectedIndex + 1]?.executionId ?? null)
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <RunsShell
        filterRail={
          <RunsFilterRail
            filters={filters}
            meta={view.meta}
            onChange={setFilters}
            onReset={() => setFilters(emptyRunsFilters)}
          />
        }
        toolbar={toolbar}
        chart={chart}
        columnHeader={
          <RunsColumnHeader
            sortField={filters.sortField}
            sortDirection={filters.sortDirection}
            onSort={onSort}
            columns={columns}
          />
        }
        onLoadMore={view.loadMore}
        hasMore={view.hasMore}
        isLoadingMore={view.isLoadingMore}
        isEmpty={!view.isLoading && !view.isError && view.rows.length === 0}
        emptyState={
          <div className="p-6 text-center font-mono text-xs text-muted-foreground">
            No runs match the current filters.
            <span className="mt-1 block text-muted-foreground/60">
              Try widening the time range or clearing a filter.
            </span>
          </div>
        }
        railCollapsed={railCollapsed}
      >
        {body}
      </RunsShell>

      <DetailDrawer
        executionId={selected}
        onClose={() => setSelected(null)}
        onPrev={prevId != null ? () => setSelected(prevId) : undefined}
        onNext={nextId != null ? () => setSelected(nextId) : undefined}
      />
    </div>
  );
}
