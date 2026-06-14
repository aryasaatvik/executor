import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";

import type { RunRow } from "../sdk/collections";
import type { ExecutionListMeta } from "../sdk/store";
import { runsAtom, type RunsQuery } from "./atoms";
import { initialRunsListState, runsListReducer, runsListRows } from "./runs-list-state";

// ---------------------------------------------------------------------------
// Runs list data hook — infinite cursor pagination + interval live polling on
// the plugin's Effect-atom client (which has no useInfiniteQuery). The atom
// returns AsyncResult; the accumulation lives in a pure reducer
// (runs-list-state) so this hook is a thin glue layer. The first-page atom is
// always subscribed so `meta` stays available while scrolling and live polling
// can refresh the head independently of the current scroll cursor.
// ---------------------------------------------------------------------------

export type RunsSortField = "startedAt" | "durationMs";

export interface RunsFilters {
  readonly status: readonly string[];
  readonly trigger: readonly string[];
  readonly interaction: "true" | "false" | null;
  readonly from: number | null;
  readonly to: number | null;
  readonly sortField: RunsSortField;
  readonly sortDirection: "asc" | "desc";
}

export const RUNS_PAGE_SIZE = 50;
const LIVE_INTERVAL_MS = 5000;

export const emptyRunsFilters: RunsFilters = {
  status: [],
  trigger: [],
  interaction: null,
  from: null,
  to: null,
  sortField: "startedAt",
  sortDirection: "desc",
};

export const buildRunsQuery = (filters: RunsFilters, cursor: string | undefined): RunsQuery => ({
  limit: RUNS_PAGE_SIZE,
  sort: filters.sortField,
  dir: filters.sortDirection,
  ...(filters.status.length > 0 ? { status: filters.status.join(",") } : {}),
  ...(filters.trigger.length > 0 ? { trigger: filters.trigger.join(",") } : {}),
  ...(filters.interaction != null ? { interaction: filters.interaction } : {}),
  ...(filters.from != null ? { from: filters.from } : {}),
  ...(filters.to != null ? { to: filters.to } : {}),
  ...(cursor !== undefined ? { cursor } : {}),
});

const filtersKey = (filters: RunsFilters): string =>
  JSON.stringify([
    filters.status,
    filters.trigger,
    filters.interaction,
    filters.from,
    filters.to,
    filters.sortField,
    filters.sortDirection,
  ]);

export interface RunsListView {
  readonly rows: readonly RunRow[];
  readonly meta: ExecutionListMeta | null;
  readonly isLoading: boolean;
  readonly isLoadingMore: boolean;
  readonly isError: boolean;
  readonly hasMore: boolean;
  readonly loadMore: () => void;
  readonly refresh: () => void;
  readonly liveCutoffId: string | null;
}

export const useRunsList = (filters: RunsFilters, live: boolean): RunsListView => {
  const [state, dispatch] = useReducer(runsListReducer, initialRunsListState);

  // Reset accumulation when the filter set changes — the documented
  // "store previous value, adjust during render" pattern (the stale render is
  // discarded before paint).
  const key = filtersKey(filters);
  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    dispatch({ type: "reset" });
  }

  const firstQuery = useMemo(() => buildRunsQuery(filters, undefined), [filters]);
  const firstAtom = useMemo(() => runsAtom(firstQuery), [firstQuery]);
  const pagedQuery = useMemo(() => buildRunsQuery(filters, state.cursor), [filters, state.cursor]);
  const pagedAtom = useMemo(() => runsAtom(pagedQuery), [pagedQuery]);
  // Page 1 reuses the first-page atom so `refresh` (which invalidates the
  // first-page atom) re-folds the head, and the head is not double-fetched —
  // Atom.family keys by object reference, so two structurally-equal queries
  // would otherwise be two distinct atoms.
  const pageAtom = state.cursor === undefined ? firstAtom : pagedAtom;

  const pageResult = useAtomValue(pageAtom);
  const firstResult = useAtomValue(firstAtom);
  const refreshFirst = useAtomRefresh(firstAtom);
  const rows = runsListRows(state);

  // Fold each settled page into the accumulator (idempotent in the reducer).
  useEffect(() => {
    if (!AsyncResult.isSuccess(pageResult) || pageResult.waiting) return;
    dispatch({
      type: "appendPage",
      cursor: state.cursor,
      runs: pageResult.value.runs,
      nextCursor: pageResult.value.nextCursor,
    });
  }, [pageResult, state.cursor]);

  // Live polling: prepend any genuinely-new head rows.
  useEffect(() => {
    if (!live || !AsyncResult.isSuccess(firstResult) || firstResult.waiting) return;
    dispatch({ type: "prependLive", runs: firstResult.value.runs });
  }, [live, firstResult]);

  useEffect(() => {
    dispatch({ type: live ? "enableLive" : "disableLive" });
  }, [live]);

  // If live was toggled on before any rows existed, anchor the divider once
  // rows arrive — otherwise the cutoff stays null for the whole session.
  useEffect(() => {
    if (live && state.liveCutoffId === null && rows.length > 0) {
      dispatch({ type: "enableLive" });
    }
  }, [live, state.liveCutoffId, rows.length]);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(refreshFirst, LIVE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [live, refreshFirst]);

  const loadMore = useCallback(() => dispatch({ type: "loadMore" }), []);
  const refresh = useCallback(() => {
    dispatch({ type: "reset" });
    refreshFirst();
  }, [refreshFirst]);

  const meta = AsyncResult.isSuccess(firstResult) ? firstResult.value.meta : null;
  const settling = AsyncResult.isInitial(pageResult) || pageResult.waiting;

  return {
    rows,
    meta,
    isLoading: rows.length === 0 && settling,
    isLoadingMore: state.cursor !== undefined && settling,
    isError: AsyncResult.isFailure(pageResult) && rows.length === 0,
    hasMore: !state.done,
    loadMore,
    refresh,
    liveCutoffId: state.liveCutoffId,
  };
};
