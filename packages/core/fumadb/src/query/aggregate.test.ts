import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { fumadb } from "@executor-js/fumadb";
import {
  createDrizzleRuntimeSchemaFromTables,
  createDrizzleRuntimeSchemaSqlFromTables,
  drizzleAdapter,
} from "@executor-js/fumadb/adapters/drizzle";
import { memoryAdapter } from "@executor-js/fumadb/adapters/memory";
import type { AbstractQuery, JsonFilter } from "@executor-js/fumadb/query";
import { column, idColumn, schema, table } from "@executor-js/fumadb/schema";

const events = table("events", {
  id: idColumn("id", "varchar(255)"),
  tenant: column("tenant", "varchar(255)"),
  data: column("data", "json"),
});

const v1 = schema({ version: "1.0.0", tables: { events } });

type EventsQuery = AbstractQuery<typeof v1>;

interface SeedRow {
  readonly id: string;
  readonly tenant: string;
  readonly data: {
    readonly status: string;
    readonly trigger: string;
    readonly startedAt: number;
    readonly durationMs: number | null;
  };
}

const seedRows: readonly SeedRow[] = [
  { id: "e1", tenant: "t1", data: { status: "completed", trigger: "cli", startedAt: 1000, durationMs: 100 } },
  { id: "e2", tenant: "t1", data: { status: "completed", trigger: "cli", startedAt: 2000, durationMs: 200 } },
  { id: "e3", tenant: "t1", data: { status: "failed", trigger: "http", startedAt: 3000, durationMs: 300 } },
  { id: "e4", tenant: "t1", data: { status: "running", trigger: "http", startedAt: 4000, durationMs: null } },
  { id: "e5", tenant: "t2", data: { status: "completed", trigger: "cli", startedAt: 5000, durationMs: 500 } },
];

const inT1 = (eb: Parameters<NonNullable<Parameters<EventsQuery["jsonCount"]>[1]["where"]>>[0]) =>
  eb("tenant", "=", "t1");

const statusIn = (values: readonly string[]): JsonFilter => ({
  kind: "array",
  path: ["status"],
  valueType: "text",
  operator: "in",
  values,
});

const seed = async (orm: EventsQuery) => {
  await orm.createMany("events", seedRows.map((row) => ({ ...row })));
};

interface Harness {
  readonly orm: EventsQuery;
  readonly close: () => Promise<void>;
}

const makeMemoryHarness = async (): Promise<Harness> => {
  const client = fumadb({ namespace: "aggregate_test", schemas: [v1] }).client(memoryAdapter());
  return { orm: client.orm("1.0.0") as EventsQuery, close: async () => {} };
};

const makeSqliteHarness = async (): Promise<Harness> => {
  const sqlite = new Database(":memory:");
  const schemaArgs = {
    tables: v1.tables,
    namespace: "aggregate_test",
    version: "1.0.0",
    provider: "sqlite",
  } as const;
  const drizzleDb = drizzle(sqlite, { schema: createDrizzleRuntimeSchemaFromTables(schemaArgs) });
  for (const statement of createDrizzleRuntimeSchemaSqlFromTables(schemaArgs)) {
    sqlite.exec(statement);
  }
  const client = fumadb({ namespace: "aggregate_test", schemas: [v1] }).client(
    drizzleAdapter({ db: drizzleDb, provider: "sqlite" }),
  );
  return {
    orm: client.orm("1.0.0") as EventsQuery,
    close: async () => {
      sqlite.close();
    },
  };
};

const runSuite = (name: string, makeHarness: () => Promise<Harness>) => {
  describe(`json aggregation (${name})`, () => {
    let harness: Harness;
    beforeEach(async () => {
      harness = await makeHarness();
      await seed(harness.orm);
    });
    afterEach(async () => {
      await harness.close();
    });

    it("jsonCount scopes by real columns and JSON filter", async () => {
      const { orm } = harness;
      expect(await orm.jsonCount("events", { column: "data", where: inT1 })).toBe(4);
      expect(await orm.jsonCount("events", { column: "data", where: (eb) => eb("tenant", "=", "t2") })).toBe(1);
      expect(
        await orm.jsonCount("events", { column: "data", where: inT1, filter: statusIn(["completed"]) }),
      ).toBe(2);
    });

    it("jsonGroupCount counts distinct values", async () => {
      const rows = await harness.orm.jsonGroupCount("events", {
        column: "data",
        where: inT1,
        path: ["status"],
      });
      const byValue = Object.fromEntries(rows.map((row) => [row.value, row.count]));
      expect(byValue).toEqual({ completed: 2, failed: 1, running: 1 });
    });

    it("jsonTimeBuckets buckets a numeric path", async () => {
      const rows = await harness.orm.jsonTimeBuckets("events", {
        column: "data",
        where: inT1,
        path: ["startedAt"],
        bucketMs: 2000,
      });
      expect(rows).toEqual([
        { bucket: 0, count: 1 },
        { bucket: 2000, count: 2 },
        { bucket: 4000, count: 1 },
      ]);
    });

    it("jsonStats computes count/min/max and continuous percentiles", async () => {
      const stats = await harness.orm.jsonStats("events", {
        column: "data",
        where: inT1,
        path: ["durationMs"],
        percentiles: [0, 0.5, 1],
      });
      expect(stats.count).toBe(3);
      expect(stats.min).toBe(100);
      expect(stats.max).toBe(300);
      expect(stats.percentiles).toEqual([
        { fraction: 0, value: 100 },
        { fraction: 0.5, value: 200 },
        { fraction: 1, value: 300 },
      ]);
    });

    it("jsonPage keyset-paginates by a JSON path with a real-column tiebreak", async () => {
      const { orm } = harness;
      const page1 = await orm.jsonPage("events", {
        column: "data",
        where: inT1,
        orderBy: [{ path: ["startedAt"], valueType: "number", direction: "desc" }],
        keyColumn: "id",
        keyDirection: "desc",
        limit: 2,
      });
      expect(page1.map((row) => row.id)).toEqual(["e4", "e3"]);

      const page2 = await orm.jsonPage("events", {
        column: "data",
        where: inT1,
        orderBy: [{ path: ["startedAt"], valueType: "number", direction: "desc" }],
        keyColumn: "id",
        keyDirection: "desc",
        limit: 2,
        cursor: { values: [3000], key: "e3" },
      });
      expect(page2.map((row) => row.id)).toEqual(["e2", "e1"]);
    });

    it("jsonPage applies the JSON filter", async () => {
      const rows = await harness.orm.jsonPage("events", {
        column: "data",
        where: inT1,
        filter: statusIn(["completed", "failed"]),
        orderBy: [{ path: ["startedAt"], valueType: "number", direction: "asc" }],
        keyColumn: "id",
        keyDirection: "asc",
        limit: 10,
      });
      expect(rows.map((row) => row.id)).toEqual(["e1", "e2", "e3"]);
    });
  });
};

runSuite("memory", makeMemoryHarness);
runSuite("sqlite", makeSqliteHarness);
