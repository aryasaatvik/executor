import * as React from "react";
import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
  type VirtualItem,
} from "@tanstack/react-virtual";

import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// VirtualList — the shared windowed-list primitive.
//
// Renders only the rows near the viewport for an arbitrary item array, so a
// list of thousands (the worst case today is a single source's ~3k tools) keeps
// a bounded DOM instead of mounting every row at once. Three concerns the web
// UI re-implements ad hoc are folded in here so every surface behaves the same:
//
//   1. Windowing — @tanstack/react-virtual with dynamic measurement, so rows of
//      uneven height (collapsible log/tool-call blocks) work without a fixed
//      itemHeight.
//   2. End-reached — the infinite-scroll trigger generalized from the runs
//      shell's hand-rolled `scrollHeight - scrollTop - clientHeight < 320`.
//   3. Scroll restoration — net-new: a list's scroll offset survives unmount /
//      remount (route change, drawer close→open) keyed by `scrollRestoreId`.
//
// Optional sticky headers (e.g. the tool tree's per-account section headers)
// are supported by marking those indices via `isSticky`: the active header is
// always kept in the render window and pinned to the top of the scroller.
//
// The runs table can't use this component directly (a real <table> needs the
// scroller to wrap <thead>+<tbody>); it composes the same building blocks
// exported below — `isNearBottom`, the scroll-position store, and the shared
// constants — against its own <tr> spacer rows.
// ---------------------------------------------------------------------------

export const DEFAULT_END_REACHED_THRESHOLD = 320;
export const DEFAULT_ESTIMATE_SIZE = 36;
export const DEFAULT_OVERSCAN = 10;

// --- scroll restoration ----------------------------------------------------
// Module-level map of last-seen scrollTop keyed by a caller-provided id. Lives
// for the lifetime of the page so a list re-mounted on the same id (back nav,
// reopened drawer) lands where the user left it. Pure data — unit-testable.
const scrollPositions = new Map<string, number>();

export function saveScrollPosition(id: string, top: number): void {
  scrollPositions.set(id, top);
}

export function readScrollPosition(id: string): number | undefined {
  return scrollPositions.get(id);
}

export function clearScrollPosition(id: string): void {
  scrollPositions.delete(id);
}

// --- end-reached math (pure, unit-testable) --------------------------------
export interface ScrollMetrics {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
}

/** True when the scroller is within `threshold` px of the bottom. */
export function isNearBottom(metrics: ScrollMetrics, threshold: number): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

// --- imperative handle -----------------------------------------------------
export interface VirtualListHandle {
  scrollToIndex: (index: number, options?: { align?: "start" | "center" | "end" }) => void;
  scrollToOffset: (offset: number) => void;
}

export interface VirtualListProps<T> {
  readonly items: readonly T[];
  readonly renderItem: (item: T, index: number) => React.ReactNode;
  readonly getKey: (item: T, index: number) => React.Key;
  /** Estimated row height in px, used before a row is measured. Default 36. */
  readonly estimateSize?: (index: number) => number;
  readonly overscan?: number;
  /** Classes for the scroll container (must establish the scroll viewport). */
  readonly className?: string;
  /** Mark an index as a sticky section header — pinned to the top while its
   *  section scrolls beneath it, and always kept in the render window. */
  readonly isSticky?: (index: number) => boolean;
  /** Fired when the viewport reaches within `endReachedThreshold` px of the
   *  bottom. Re-entrancy is the caller's responsibility (guard on
   *  hasMore/isLoading), matching the existing runs-shell contract. */
  readonly onEndReached?: () => void;
  readonly endReachedThreshold?: number;
  /** Preserve/restore scroll offset across unmount under this id. */
  readonly scrollRestoreId?: string;
  readonly isLoading?: boolean;
  readonly renderLoading?: () => React.ReactNode;
  readonly renderEmpty?: () => React.ReactNode;
  /** Rendered in normal flow below the windowed rows — e.g. a "Loading more…"
   *  / "End of history" sentinel. */
  readonly footer?: React.ReactNode;
  readonly apiRef?: React.Ref<VirtualListHandle>;
  readonly "aria-label"?: string;
}

export function VirtualList<T>(props: VirtualListProps<T>) {
  const {
    items,
    renderItem,
    getKey,
    estimateSize,
    overscan = DEFAULT_OVERSCAN,
    className,
    isSticky,
    onEndReached,
    endReachedThreshold = DEFAULT_END_REACHED_THRESHOLD,
    scrollRestoreId,
    isLoading,
    renderLoading,
    renderEmpty,
    footer,
    apiRef,
  } = props;

  const scrollRef = React.useRef<HTMLDivElement>(null);

  // Indices that pin to the top. Recomputed when the row set changes.
  const stickyIndices = React.useMemo(() => {
    if (!isSticky) return [] as number[];
    const acc: number[] = [];
    for (let i = 0; i < items.length; i++) {
      if (isSticky(i)) acc.push(i);
    }
    return acc;
  }, [items, isSticky]);

  // The header currently pinned — the last sticky index at or above the top of
  // the window. Tracked in a ref so the range extractor can keep it mounted.
  const activeStickyRef = React.useRef<number | null>(null);

  const rangeExtractor = React.useCallback(
    (range: Range): number[] => {
      if (stickyIndices.length === 0) {
        activeStickyRef.current = null;
        return defaultRangeExtractor(range);
      }
      let active: number | null = null;
      for (const idx of stickyIndices) {
        if (idx <= range.startIndex) active = idx;
        else break;
      }
      activeStickyRef.current = active;
      const indices = new Set(defaultRangeExtractor(range));
      if (active !== null) indices.add(active);
      return [...indices].sort((a, b) => a - b);
    },
    [stickyIndices],
  );

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimateSize ?? (() => DEFAULT_ESTIMATE_SIZE),
    overscan,
    rangeExtractor,
  });

  React.useImperativeHandle(
    apiRef,
    () => ({
      scrollToIndex: (index, options) => virtualizer.scrollToIndex(index, options),
      scrollToOffset: (offset) => virtualizer.scrollToOffset(offset),
    }),
    [virtualizer],
  );

  // Restore on mount; persist on unmount. Restore runs in a layout effect so the
  // jump happens before paint. The estimate-based total size is in place by then,
  // which is close enough for keyset lists; exact dynamic-measure drift is minor.
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!scrollRestoreId || !el) return;
    const saved = readScrollPosition(scrollRestoreId);
    if (saved !== undefined && saved > 0) {
      el.scrollTop = saved;
    }
    // `el` is captured here so the cleanup saves the same node it restored — the
    // scroll container is stable for the component's life (single container,
    // inner content swaps for loading/empty states).
    return () => saveScrollPosition(scrollRestoreId, el.scrollTop);
  }, [scrollRestoreId]);

  const handleScroll = React.useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const el = event.currentTarget;
      if (scrollRestoreId) saveScrollPosition(scrollRestoreId, el.scrollTop);
      if (onEndReached && isNearBottom(el, endReachedThreshold)) onEndReached();
    },
    [onEndReached, endReachedThreshold, scrollRestoreId],
  );

  // One stable scroll container across loading / empty / populated states so the
  // virtualizer's scroll element and the restore ref never swap nodes underfoot.
  const showLoading = isLoading && items.length === 0;
  const showEmpty = !showLoading && items.length === 0;
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className={cn("overflow-auto", className)}
      aria-label={props["aria-label"]}
    >
      {showLoading ? (
        renderLoading?.()
      ) : showEmpty ? (
        <>
          {renderEmpty?.()}
          {footer}
        </>
      ) : (
        <>
          <div style={{ position: "relative", width: "100%", height: virtualizer.getTotalSize() }}>
            {virtualItems.map((virtualItem) => {
              const index = virtualItem.index;
              const pinned = activeStickyRef.current === index && isSticky?.(index) === true;
              return (
                <div
                  key={getKey(items[index]!, index)}
                  data-index={index}
                  ref={virtualizer.measureElement}
                  style={
                    pinned
                      ? { position: "sticky", top: 0, zIndex: 2, width: "100%" }
                      : {
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${virtualItem.start}px)`,
                        }
                  }
                >
                  {renderItem(items[index]!, index)}
                </div>
              );
            })}
          </div>
          {footer}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// useWindowedRows — windowing for surfaces that can't use <div> rows.
//
// A real <table> needs its scroll container to wrap <thead>+<tbody>, so the runs
// table can't drop in <VirtualList>. This hook exposes the same engine: attach
// `scrollRef` to the scroll container, render a top spacer row of height
// `paddingTop`, the `virtualItems`, then a bottom spacer of `paddingBottom`.
// `onScroll` fires end-reached and persists scroll position, mirroring the
// component. Rows are assumed near-uniform height (fixed `estimateSize`); the
// sticky-header offset is absorbed by `overscan`.
// ---------------------------------------------------------------------------
export interface WindowedRows {
  readonly scrollRef: React.RefObject<HTMLDivElement | null>;
  readonly virtualItems: readonly VirtualItem[];
  readonly paddingTop: number;
  readonly paddingBottom: number;
  readonly onScroll: (event: React.UIEvent<HTMLDivElement>) => void;
}

export function useWindowedRows(options: {
  readonly count: number;
  readonly estimateSize?: number;
  readonly overscan?: number;
  readonly onEndReached?: () => void;
  readonly endReachedThreshold?: number;
  readonly scrollRestoreId?: string;
}): WindowedRows {
  const {
    count,
    estimateSize = DEFAULT_ESTIMATE_SIZE,
    overscan = DEFAULT_OVERSCAN,
    onEndReached,
    endReachedThreshold = DEFAULT_END_REACHED_THRESHOLD,
    scrollRestoreId,
  } = options;

  const scrollRef = React.useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan,
  });

  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!scrollRestoreId || !el) return;
    const saved = readScrollPosition(scrollRestoreId);
    if (saved !== undefined && saved > 0) el.scrollTop = saved;
    return () => saveScrollPosition(scrollRestoreId, el.scrollTop);
  }, [scrollRestoreId]);

  const onScroll = React.useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const el = event.currentTarget;
      if (scrollRestoreId) saveScrollPosition(scrollRestoreId, el.scrollTop);
      if (onEndReached && isNearBottom(el, endReachedThreshold)) onEndReached();
    },
    [onEndReached, endReachedThreshold, scrollRestoreId],
  );

  const virtualItems = virtualizer.getVirtualItems();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0]!.start : 0;
  const paddingBottom =
    virtualItems.length > 0
      ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1]!.end
      : 0;

  return { scrollRef, virtualItems, paddingTop, paddingBottom, onScroll };
}
