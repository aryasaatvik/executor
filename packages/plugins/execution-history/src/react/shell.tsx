import * as React from "react";

import { cn } from "@executor-js/react/lib/utils";

// ---------------------------------------------------------------------------
// RunsShell — two-column layout (filter rail + main pane) with infinite scroll.
//
// The left <aside> renders the filter rail at ~15rem wide and can be collapsed
// via railCollapsed. The right main pane stacks: sticky toolbar → optional
// chart → sticky column header → scrollable body. The body fires onLoadMore
// when the user scrolls within 320px of the bottom, guarded against re-firing
// while already loading.
// ---------------------------------------------------------------------------

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

  const toolbarRef = React.useRef<HTMLDivElement>(null);
  const columnHeaderRef = React.useRef<HTMLDivElement>(null);
  const [stickyTop, setStickyTop] = React.useState(0);

  // Track combined height of toolbar + chart so the column header can stick
  // directly below them.
  React.useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      setStickyTop(height);
    });
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, []);

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
        {/* Sticky toolbar + chart */}
        <div
          ref={toolbarRef}
          className="sticky top-0 z-30 flex flex-col border-b border-border bg-background"
        >
          <div className="flex flex-col">{toolbar}</div>
          {chart != null && <div className="flex flex-col">{chart}</div>}
        </div>

        {/* Sticky column header */}
        <div
          ref={columnHeaderRef}
          className="sticky z-20 border-b border-border/60 bg-background"
          style={{ top: stickyTop }}
        >
          {columnHeader}
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto" onScroll={onScroll}>
          {isEmpty ? (
            <div className="flex h-full min-h-48 items-center justify-center px-4 py-8">
              {emptyState ?? (
                <p className="font-mono text-xs text-muted-foreground">
                  No runs match the current filters.
                </p>
              )}
            </div>
          ) : (
            <>
              {children}
              {isLoadingMore && (
                <div className="flex w-full items-center justify-center border-t border-border/50 py-3 font-mono text-[11px] uppercase tracking-wider text-muted-foreground/60">
                  Loading more…
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
