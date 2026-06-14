import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  ExecutionFinished,
  ExecutionId,
  ExecutionStarted,
  Subject,
  Tenant,
} from "@executor-js/sdk";
import type { ExecutionEvent, StorageFailure } from "@executor-js/sdk/core";
import { makeTestExecutor } from "@executor-js/sdk/testing";

import type { RunStatus } from "./collections";
import { executionHistoryPlugin } from "./plugin";

const owner = { tenant: Tenant.make("tenant_test"), subject: Subject.make("subject_test") };

interface SeedRun {
  readonly id: string;
  readonly status: "completed" | "failed";
  readonly trigger: string;
  readonly startedAt: number;
  readonly durationMs: number;
}

/** Only the writer surface seeding needs — the tests call `list` on the full
 *  inferred executor directly. */
interface HistoryWriter {
  readonly executionHistory: {
    readonly handleEvent: (event: ExecutionEvent) => Effect.Effect<void, StorageFailure>;
  };
}

const makeExecutor = () =>
  makeTestExecutor({ backend: "sqlite", plugins: [executionHistoryPlugin()] as const });

const seedRun = (executor: HistoryWriter, run: SeedRun) =>
  Effect.gen(function* () {
    const executionId = ExecutionId.make(run.id);
    yield* executor.executionHistory.handleEvent(
      new ExecutionStarted({
        executionId,
        owner,
        code: "noop",
        trigger: { kind: run.trigger },
        startedAt: new Date(run.startedAt),
      }),
    );
    yield* executor.executionHistory.handleEvent(
      new ExecutionFinished({
        executionId,
        owner,
        status: run.status,
        result: { ok: true },
        logs: [],
        completedAt: new Date(run.startedAt + run.durationMs),
      }),
    );
  });

// Five completed (cli) + two failed (http), startedAt 1000..7000.
const seedRows: readonly SeedRun[] = [
  { id: "r1", status: "completed", trigger: "cli", startedAt: 1000, durationMs: 100 },
  { id: "r2", status: "completed", trigger: "cli", startedAt: 2000, durationMs: 200 },
  { id: "r3", status: "completed", trigger: "cli", startedAt: 3000, durationMs: 300 },
  { id: "r4", status: "completed", trigger: "cli", startedAt: 4000, durationMs: 400 },
  { id: "r5", status: "completed", trigger: "cli", startedAt: 5000, durationMs: 500 },
  { id: "r6", status: "failed", trigger: "http", startedAt: 6000, durationMs: 600 },
  { id: "r7", status: "failed", trigger: "http", startedAt: 7000, durationMs: 700 },
];

const statusMap = (counts: readonly { status: RunStatus; count: number }[]) =>
  Object.fromEntries(counts.map((entry) => [entry.status, entry.count]));

describe("execution-history list — meta, facets, keyset", () => {
  it.effect("returns facet counts and a stacked timeline on the first page", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      yield* Effect.forEach(seedRows, (row) => seedRun(executor, row), { discard: true });

      const page = yield* executor.executionHistory.list({ limit: 3 });
      expect(page.runs.map((run) => run.executionId)).toEqual(["r7", "r6", "r5"]);
      expect(page.nextCursor).not.toBeNull();

      const meta = page.meta;
      expect(meta?.totalRowCount).toBe(7);
      expect(meta?.filterRowCount).toBe(7);
      expect(statusMap(meta?.statusCounts ?? [])).toEqual({ completed: 5, failed: 2 });
      expect(
        Object.fromEntries((meta?.triggerCounts ?? []).map((t) => [t.triggerKind, t.count])),
      ).toEqual({ cli: 5, http: 2 });
      expect(meta?.durationStats.count).toBe(7);
      expect(meta?.durationStats.min).toBe(100);
      expect(meta?.durationStats.max).toBe(700);
      expect(meta?.durationStats.p50).toBe(400);
      // Stacked timeline: each bucket carries per-status counts.
      const totalCharted = (meta?.chartData ?? []).reduce(
        (sum, bucket) => sum + Object.values(bucket.counts).reduce((a, b) => a + b, 0),
        0,
      );
      expect(totalCharted).toBe(7);
    }),
  );

  it.effect("keyset-paginates forward with the cursor", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      yield* Effect.forEach(seedRows, (row) => seedRun(executor, row), { discard: true });

      const page1 = yield* executor.executionHistory.list({ limit: 3 });
      expect(page1.runs.map((r) => r.executionId)).toEqual(["r7", "r6", "r5"]);

      const page2 = yield* executor.executionHistory.list({
        limit: 3,
        cursor: page1.nextCursor ?? undefined,
      });
      expect(page2.runs.map((r) => r.executionId)).toEqual(["r4", "r3", "r2"]);
      // Meta is computed only on the first page.
      expect(page2.meta).toBeNull();

      const page3 = yield* executor.executionHistory.list({
        limit: 3,
        cursor: page2.nextCursor ?? undefined,
      });
      expect(page3.runs.map((r) => r.executionId)).toEqual(["r1"]);
      expect(page3.nextCursor).toBeNull();
    }),
  );

  it.effect("status facet ignores the status filter; filterRowCount honors it", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      yield* Effect.forEach(seedRows, (row) => seedRun(executor, row), { discard: true });

      const page = yield* executor.executionHistory.list({
        limit: 10,
        statusFilter: ["failed"],
      });
      expect(page.runs.map((r) => r.executionId)).toEqual(["r7", "r6"]);
      expect(page.meta?.filterRowCount).toBe(2);
      // The status facet still shows every option so the rail stays usable.
      expect(statusMap(page.meta?.statusCounts ?? [])).toEqual({ completed: 5, failed: 2 });
    }),
  );

  it.effect("the live `after` floor returns only newer runs and skips meta", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      yield* Effect.forEach(seedRows, (row) => seedRun(executor, row), { discard: true });

      const page = yield* executor.executionHistory.list({ limit: 10, after: 5000 });
      expect(page.runs.map((r) => r.executionId)).toEqual(["r7", "r6"]);
      expect(page.meta).toBeNull();
    }),
  );
});
