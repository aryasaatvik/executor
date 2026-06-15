import * as React from "react";

import { cn } from "@executor-js/react/lib/utils";

// ---------------------------------------------------------------------------
// RunsShell — two-column layout (filter rail + main pane) with infinite scroll.
//
// The left <aside> renders the filter rail at ~15rem wide and can be collapsed
// via railCollapsed. The right main pane stacks the full-width toolbar + chart
// above a single table scroller that owns both axes. The table is a real
// semantic <table> with content-fit columns (table-layout: auto): the sticky
// <thead> and the <tbody> rows share one column model, so columns size to their
// widest cell and stay aligned for free — no fixed widths. The scroller fires
// onLoadMore when the user scrolls within 320px of the bottom, guarded against
// re-firing while loading.
// ---------------------------------------------------------------------------

// Upper bound on the visible column count (dot + started + status + up to six
// optional columns + code = 10). Full-width message rows span the whole table
// with this; an over-count colSpan is harmless (the browser clamps it).
export const RUNS_TABLE_COLSPAN = 12;

export interface RunsShellProps {
  readonly filterRail: React.ReactNode;
  readonly toolbar: React.ReactNode;
  readonly chart?: React.ReactNode;
  readonly columnHeader: React.ReactNode;
  readonly children: React.ReactNode;
  readonly onLoadMore: () => void;
  readonly hasMore: boolean;
  readonly isLoadingMore: boolean;
  readonly isEmpty: boolean;
  readonly emptyState?: React.ReactNode;
  readonly railCollapsed?: boolean;
}

const SCROLL_THRESHOLD = 320;

export function RunsShell(props: RunsShellProps) {
  const {
    filterRail,
    toolbar,
    chart,
    columnHeader,
    children,
    onLoadMore,
    hasMore,
    isLoadingMore,
    isEmpty,
    emptyState,
    railCollapsed,
  } = props;

  const onScroll = React.useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (!hasMore || isLoadingMore || isEmpty) return;
      const target = event.currentTarget;
      const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
      if (distanceFromBottom < SCROLL_THRESHOLD) {
        onLoadMore();
      }
    },
    [hasMore, isLoadingMore, isEmpty, onLoadMore],
  );

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

        {/* Table scroller — owns both axes. The sticky <thead> sticks to the top
            of this scroller (below the toolbar/chart) and rides the same
            horizontal scroll as the rows. `border-separate border-spacing-0`
            keeps cell borders rendering on the sticky header (a known
            border-collapse + sticky browser bug). No table width is forced, so
            columns content-fit: narrower than the pane → left-aligned with slack
            on the right; wider → horizontal scroll. */}
        <div className="min-h-0 flex-1 overflow-auto" onScroll={onScroll}>
          {/* oxlint-disable-next-line react/forbid-elements -- the runs table needs
              this custom scroll container (the onScroll infinite-scroll handler) +
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
              ) : (
                <>
                  {children}
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
