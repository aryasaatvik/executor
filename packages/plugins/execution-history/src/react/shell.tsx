import * as React from "react";

import { cn } from "@executor-js/react/lib/utils";
import { useWindowedRows } from "@executor-js/react/components/virtual-list";

// ---------------------------------------------------------------------------
// RunsShell — two-column layout (filter rail + main pane) with a windowed,
// infinite-scrolling table.
//
// The left <aside> renders the filter rail at ~15rem wide and can be collapsed
// via railCollapsed. The right main pane stacks the full-width toolbar + chart
// above a single table scroller that owns both axes. The table stays a real
// semantic <table> with a sticky <thead>; only the rows near the viewport are
// mounted, with top/bottom spacer <tr>s standing in for the rest (useWindowedRows
// from the shared virtualization primitive). The two columns that can run long —
// actor and code — are width-capped in run-row.tsx, so windowing a subset doesn't
// make `table-layout: auto` columns jitter as rows scroll in. The scroller fires
// onLoadMore within 320px of the bottom, guarded against re-firing while loading.
// ---------------------------------------------------------------------------

// Upper bound on the visible column count (dot + started + status + up to six
// optional columns + code = 10). Full-width message rows span the whole table
// with this; an over-count colSpan is harmless (the browser clamps it).
export const RUNS_TABLE_COLSPAN = 12;

// Approximate keyset row height (run-row.tsx: px-3 py-2 + border ≈ 33px). Rows
// are near-uniform, so a fixed estimate keeps the spacer math stable.
const RUNS_ROW_ESTIMATE = 33;

export interface RunsShellRow {
  readonly key: React.Key;
  readonly node: React.ReactNode;
}

export interface RunsShellProps {
  readonly filterRail: React.ReactNode;
  readonly toolbar: React.ReactNode;
  readonly chart?: React.ReactNode;
  readonly columnHeader: React.ReactNode;
  /** Windowed body rows — run rows plus the interleaved live divider. */
  readonly rows: readonly RunsShellRow[];
  readonly estimateRowSize?: number;
  readonly scrollRestoreId?: string;
  readonly onLoadMore: () => void;
  readonly hasMore: boolean;
  readonly isLoadingMore: boolean;
  readonly isEmpty: boolean;
  readonly emptyState?: React.ReactNode;
  /** A full-width <tr> shown instead of the windowed rows (loading / error). */
  readonly statusRow?: React.ReactNode;
  /** A <tr> appended after the rows — e.g. the load-more retry prompt. */
  readonly loadMoreError?: React.ReactNode;
  readonly railCollapsed?: boolean;
}

export function RunsShell(props: RunsShellProps) {
  const {
    filterRail,
    toolbar,
    chart,
    columnHeader,
    rows,
    estimateRowSize,
    scrollRestoreId,
    onLoadMore,
    hasMore,
    isLoadingMore,
    isEmpty,
    emptyState,
    statusRow,
    loadMoreError,
    railCollapsed,
  } = props;

  const canLoadMore = hasMore && !isLoadingMore && !isEmpty;
  const { scrollRef, virtualItems, paddingTop, paddingBottom, onScroll } = useWindowedRows({
    count: rows.length,
    estimateSize: estimateRowSize ?? RUNS_ROW_ESTIMATE,
    overscan: 16,
    onEndReached: canLoadMore ? onLoadMore : undefined,
    scrollRestoreId,
  });

  return (
    <div className="flex h-full min-h-0 flex-row bg-background text-foreground">
      {/* Filter rail */}
      <aside
        className={cn(
          "hidden shrink-0 flex-col border-r border-border lg:flex",
          "w-60",
          railCollapsed && "lg:hidden",
        )}
      >
        <div className="min-h-0 flex-1 overflow-y-auto">{filterRail}</div>
      </aside>

      {/* Main pane */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Toolbar + chart — full-width controls, do not scroll with the table */}
        <div className="z-30 flex flex-col border-b border-border bg-background">
          <div className="flex flex-col">{toolbar}</div>
          {chart != null && <div className="flex flex-col">{chart}</div>}
        </div>

        {/* Table scroller — owns both axes and is the virtualizer's scroll
            element. The sticky <thead> rides the same scroll; only near-viewport
            rows mount, bracketed by spacer <tr>s. `border-separate
            border-spacing-0` keeps cell borders on the sticky header. */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" onScroll={onScroll}>
          {/* oxlint-disable-next-line react/forbid-elements -- the runs table needs
              this custom scroll container (the windowed infinite-scroll handler) +
              a sticky thead inside it; the shared <Table> wraps its own
              overflow-x-auto div, which would conflict. Same suppression the
              shared Table component itself uses on its raw <table>. */}
          <table className="border-separate border-spacing-0 font-mono text-xs">
            <thead className="sticky top-0 z-20">{columnHeader}</thead>
            <tbody>
              {isEmpty ? (
                <tr>
                  <td colSpan={RUNS_TABLE_COLSPAN} className="px-4 py-8 text-center">
                    {emptyState ?? (
                      <span className="font-mono text-xs text-muted-foreground">
                        No runs match the current filters.
                      </span>
                    )}
                  </td>
                </tr>
              ) : statusRow != null ? (
                statusRow
              ) : (
                <>
                  {paddingTop > 0 && (
                    <tr aria-hidden>
                      <td
                        colSpan={RUNS_TABLE_COLSPAN}
                        className="border-0 p-0"
                        style={{ height: paddingTop }}
                      />
                    </tr>
                  )}
                  {virtualItems.map((item) => (
                    <React.Fragment key={rows[item.index]!.key}>
                      {rows[item.index]!.node}
                    </React.Fragment>
                  ))}
                  {paddingBottom > 0 && (
                    <tr aria-hidden>
                      <td
                        colSpan={RUNS_TABLE_COLSPAN}
                        className="border-0 p-0"
                        style={{ height: paddingBottom }}
                      />
                    </tr>
                  )}
                  {loadMoreError}
                  {isLoadingMore && (
                    <tr>
                      <td
                        colSpan={RUNS_TABLE_COLSPAN}
                        className="border-t border-border/50 py-3 text-center font-mono text-[11px] uppercase tracking-wider text-muted-foreground/60"
                      >
                        Loading more…
                      </td>
                    </tr>
                  )}
                  {!hasMore && !isLoadingMore && (
                    <tr>
                      <td
                        colSpan={RUNS_TABLE_COLSPAN}
                        className="border-t border-border/40 py-3 text-center font-mono text-[11px] uppercase tracking-wider text-muted-foreground/40"
                      >
                        End of history
                      </td>
                    </tr>
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
