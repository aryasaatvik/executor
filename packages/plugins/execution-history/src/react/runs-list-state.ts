import type { RunRow } from "../sdk/collections";

// ---------------------------------------------------------------------------
// Pure state machine for the runs list. Kept free of React/atoms so the
// fiddly accumulation + live-prepend logic is unit-testable.
//
// Two row sources merge into one display list (newest first):
//   - `live`  — rows that arrived via live polling after live mode was enabled
//   - `pages` — the cursor-paginated scroll history (page 1, page 2, ...)
// A `seen` set dedupes across both so the same run never appears twice and a
// live refresh only ever prepends genuinely new runs. Append/prepend are
// idempotent (guarded by `seen`/`appended`), so the React effects that drive
// them can fire repeatedly without corrupting state.
// ---------------------------------------------------------------------------

export interface RunsListState {
  /** Cursor-paginated scroll history; each page is newest-first. */
  readonly pages: readonly (readonly RunRow[])[];
  /** Rows prepended by live polling, newest-first. */
  readonly live: readonly RunRow[];
  /** executionIds present in `pages` or `live`. */
  readonly seen: ReadonlySet<string>;
  /** Cursor of the page currently subscribed (undefined = first page). */
  readonly cursor: string | undefined;
  /** Page keys already folded in (cursor ?? ""), for idempotent appends. */
  readonly appended: ReadonlySet<string>;
  /** nextCursor of the most recently appended page. */
  readonly nextCursor: string | null;
  /** True once a page returns no nextCursor. */
  readonly done: boolean;
  /** Divider anchor: the top row id when live mode was enabled. */
  readonly liveCutoffId: string | null;
}

export type RunsListAction =
  | {
      readonly type: "appendPage";
      readonly cursor: string | undefined;
      readonly runs: readonly RunRow[];
      readonly nextCursor: string | null;
    }
  | { readonly type: "loadMore" }
  | { readonly type: "enableLive" }
  | { readonly type: "disableLive" }
  | { readonly type: "prependLive"; readonly runs: readonly RunRow[] }
  | { readonly type: "reset" };

export const initialRunsListState: RunsListState = {
  pages: [],
  live: [],
  seen: new Set(),
  cursor: undefined,
  appended: new Set(),
  nextCursor: null,
  done: false,
  liveCutoffId: null,
};

const pageKey = (cursor: string | undefined): string => cursor ?? "";

const topRowId = (state: RunsListState): string | null =>
  state.live[0]?.executionId ?? state.pages[0]?.[0]?.executionId ?? null;

export const runsListReducer = (state: RunsListState, action: RunsListAction): RunsListState => {
  if (action.type === "appendPage") {
    const key = pageKey(action.cursor);
    if (state.appended.has(key)) return state;
    const fresh = action.runs.filter((run) => !state.seen.has(run.executionId));
    const seen = new Set(state.seen);
    for (const run of fresh) seen.add(run.executionId);
    return {
      ...state,
      pages: [...state.pages, fresh],
      seen,
      appended: new Set(state.appended).add(key),
      nextCursor: action.nextCursor,
      done: action.nextCursor === null,
    };
  }
  if (action.type === "loadMore") {
    if (state.done || state.nextCursor === null || state.nextCursor === state.cursor) {
      return state;
    }
    return { ...state, cursor: state.nextCursor };
  }
  if (action.type === "enableLive") {
    return { ...state, liveCutoffId: topRowId(state) };
  }
  if (action.type === "disableLive") {
    return { ...state, liveCutoffId: null };
  }
  if (action.type === "prependLive") {
    // Append-only: a live refresh only adds genuinely-new runs. A run already
    // displayed keeps the data it was first seen with — a status transition
    // (running -> completed) is not reflected until the list is reset/refiltered
    // (the aggregate `meta` does update live). Acceptable for v1.
    const fresh = action.runs.filter((run) => !state.seen.has(run.executionId));
    if (fresh.length === 0) return state;
    const seen = new Set(state.seen);
    for (const run of fresh) seen.add(run.executionId);
    return { ...state, live: [...fresh, ...state.live], seen };
  }
  // action.type === "reset"
  return initialRunsListState;
};

/**
 * The merged display list. With `liveFirst` (the default, for descending /
 * newest-first sort) live rows go on top; otherwise (ascending sort) they are
 * appended after the paginated rows so the live tail stays at the bottom.
 */
export const runsListRows = (state: RunsListState, liveFirst = true): readonly RunRow[] =>
  liveFirst ? [...state.live, ...state.pages.flat()] : [...state.pages.flat(), ...state.live];
