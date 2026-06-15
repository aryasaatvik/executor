import { describe, expect, it } from "@effect/vitest";

import type { RunRow } from "../sdk/collections";
import {
  initialRunsListState,
  runsListReducer,
  runsListRows,
  type RunsListAction,
  type RunsListState,
} from "./runs-list-state";

const row = (id: string, startedAt: number): RunRow => ({
  executionId: id,
  status: "completed",
  codePreview: "noop",
  triggerKind: "cli",
  logErrorCount: 0,
  logWarnCount: 0,
  actorId: null,
  actorLabel: null,
  actorKind: null,
  startedAt,
  completedAt: startedAt + 100,
  durationMs: 100,
  toolCallCount: 0,
  hadInteraction: false,
});

const run = (actions: readonly RunsListAction[], from: RunsListState = initialRunsListState) =>
  actions.reduce(runsListReducer, from);

describe("runsListReducer", () => {
  it("appends cursor pages in order and merges into one list", () => {
    const state = run([
      {
        type: "appendPage",
        cursor: undefined,
        runs: [row("r3", 3000), row("r2", 2000)],
        nextCursor: "c2",
      },
      { type: "loadMore" },
      { type: "appendPage", cursor: "c2", runs: [row("r1", 1000)], nextCursor: null },
    ]);
    expect(runsListRows(state).map((r) => r.executionId)).toEqual(["r3", "r2", "r1"]);
    expect(state.done).toBe(true);
    expect(state.cursor).toBe("c2");
  });

  it("ignores a duplicate appendPage for the same cursor (idempotent)", () => {
    const page = {
      type: "appendPage",
      cursor: undefined,
      runs: [row("r1", 1000)],
      nextCursor: "c2",
    } as const;
    const state = run([page, page]);
    expect(state.pages).toHaveLength(1);
    expect(runsListRows(state).map((r) => r.executionId)).toEqual(["r1"]);
  });

  it("loadMore is a no-op when there is no next cursor", () => {
    const state = run([
      { type: "appendPage", cursor: undefined, runs: [row("r1", 1000)], nextCursor: null },
      { type: "loadMore" },
    ]);
    expect(state.cursor).toBeUndefined();
  });

  it("prependLive adds only unseen rows, newest-first, above existing pages", () => {
    const base = run([
      {
        type: "appendPage",
        cursor: undefined,
        runs: [row("r2", 2000), row("r1", 1000)],
        nextCursor: null,
      },
      { type: "enableLive" },
    ]);
    expect(base.liveCutoffId).toBe("r2");

    // A live refresh returns the new top row r3 plus the already-seen r2/r1.
    const live = runsListReducer(base, {
      type: "prependLive",
      runs: [row("r3", 3000), row("r2", 2000), row("r1", 1000)],
    });
    expect(runsListRows(live).map((r) => r.executionId)).toEqual(["r3", "r2", "r1"]);

    // A second identical refresh adds nothing.
    const again = runsListReducer(live, {
      type: "prependLive",
      runs: [row("r3", 3000), row("r2", 2000)],
    });
    expect(again).toBe(live);
  });

  it("dedupes a run that appears in both a live refresh and a later page", () => {
    const state = run([
      { type: "appendPage", cursor: undefined, runs: [row("r2", 2000)], nextCursor: "c2" },
      { type: "prependLive", runs: [row("r3", 3000)] },
      { type: "loadMore" },
      // page 2 happens to re-include r3 (race); it must not double up.
      {
        type: "appendPage",
        cursor: "c2",
        runs: [row("r3", 3000), row("r1", 1000)],
        nextCursor: null,
      },
    ]);
    expect(runsListRows(state).map((r) => r.executionId)).toEqual(["r3", "r2", "r1"]);
  });

  it("runsListRows(state, false) places live rows after pages.flat()", () => {
    const state = run([
      {
        type: "appendPage",
        cursor: undefined,
        runs: [row("r2", 2000), row("r1", 1000)],
        nextCursor: null,
      },
      { type: "prependLive", runs: [row("r3", 3000)] },
    ]);
    // Default (liveFirst) keeps the live row on top.
    expect(runsListRows(state).map((r) => r.executionId)).toEqual(["r3", "r2", "r1"]);
    // Ascending sort appends live rows after the paginated rows.
    expect(runsListRows(state, false).map((r) => r.executionId)).toEqual(["r2", "r1", "r3"]);
  });

  it("reset clears all accumulated state", () => {
    const state = run([
      { type: "appendPage", cursor: undefined, runs: [row("r1", 1000)], nextCursor: "c2" },
      { type: "enableLive" },
      { type: "reset" },
    ]);
    expect(state).toEqual(initialRunsListState);
  });
});
