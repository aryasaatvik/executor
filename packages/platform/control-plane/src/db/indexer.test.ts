import { createHash } from "node:crypto";
import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";
import { SqlClient } from "@effect/sql";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vitest";

import { buildSearchText, indexSource, type SourceToIndex, type ToolToIndex } from "./indexer";
import { source } from "./schema";

vi.stubGlobal("Bun", {
  CryptoHasher: class {
    private readonly inner = createHash("sha256");

    update(value: string) {
      this.inner.update(value);
      return this;
    }

    digest(encoding: "hex") {
      return this.inner.digest(encoding);
    }
  },
});

const computeContentHash = (tool: ToolToIndex): string => {
  const hasher = createHash("sha256");
  const searchText = buildSearchText(tool);
  hasher.update(JSON.stringify({
    path: tool.path,
    sourceKey: tool.sourceKey,
    namespace: tool.namespace,
    title: tool.title ?? null,
    description: tool.description ?? null,
    searchText,
    inputSchemaJson: tool.inputSchemaJson ?? null,
    outputSchemaJson: tool.outputSchemaJson ?? null,
    inputTypePreview: tool.inputTypePreview ?? null,
    outputTypePreview: tool.outputTypePreview ?? null,
    interaction: tool.interaction ?? "auto",
    providerKind: tool.providerKind ?? null,
  }));
  return hasher.digest("hex") as string;
};

const baseTool: ToolToIndex = {
  toolId: "github.issues.create",
  path: "github.issues.create",
  sourceId: "source-github",
  sourceKey: "github",
  namespace: "github.issues",
  searchText: "github github.issues GitHub Create Issue streamable-http oauth",
  description: "Create a GitHub issue",
};

const baseSource: SourceToIndex = {
  sourceId: "source-github",
  workspaceId: "workspace-1",
  name: "GitHub",
  kind: "openapi",
  endpoint: "https://api.github.com",
  status: "connected",
  enabled: true,
  namespace: "github",
  createdAt: 1,
  updatedAt: 2,
};

const makeDb = (existingRows: Array<{
  tool_id: string;
  content_hash: string;
  source_enabled: boolean;
  source_status: string | null;
}>) => {
  const updates: Array<Record<string, unknown>> = [];
  const toolInserts: Array<Record<string, unknown>> = [];
  const sourceUpserts: Array<{
    values: Record<string, unknown>;
    set: Record<string, unknown>;
  }> = [];
  const operations: string[] = [];

  return {
    updates,
    toolInserts,
    sourceUpserts,
    operations,
    db: {
      select: () => ({
        from: () => ({
          where: () => Effect.succeed(existingRows),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            updates.push(values);
            operations.push("tool-update");
            return Effect.void;
          },
        }),
      }),
      insert: (table: unknown) =>
        table === source
          ? {
              values: (values: Record<string, unknown>) => ({
                onConflictDoUpdate: ({
                  set,
                }: {
                  set: Record<string, unknown>;
                }) => {
                  sourceUpserts.push({ values, set });
                  operations.push("source-upsert");
                  return Effect.void;
                },
              }),
            }
          : {
              values: (values: Record<string, unknown>) => {
                toolInserts.push(values);
                operations.push("tool-insert");
                return Effect.void;
              },
            },
      delete: () => ({
        where: () => Effect.void,
      }),
    },
  };
};

const makeSql = {
  withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
};

describe("indexSource", () => {
  it("preserves the richer runtime search document in SQLite FTS text", () => {
    const tool: ToolToIndex = {
      ...baseTool,
      inputSchemaJson: {
        properties: {
          owner: { type: "string" },
        },
      },
    };

    expect(buildSearchText(tool)).toContain(`search: ${tool.searchText}`);
    expect(buildSearchText(tool)).toContain("params: owner (string)");
  });

  it.effect("does not rewrite unchanged active rows", () =>
    Effect.gen(function* () {
      const unchangedHash = computeContentHash(baseTool);
      const fake = makeDb([
        {
          tool_id: baseTool.toolId,
          content_hash: unchangedHash,
          source_enabled: true,
          source_status: "connected",
        },
      ]);

      const result = yield* indexSource({
        sourceId: baseTool.sourceId,
        sourceKey: baseTool.sourceKey,
        source: baseSource,
        tools: [baseTool],
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(SqliteDrizzle, fake.db as never),
            Layer.succeed(SqlClient.SqlClient, makeSql as never),
          ),
        ),
      );

      expect(result.changedTools).toEqual([]);
      expect(fake.updates).toEqual([]);
      expect(fake.toolInserts).toEqual([]);
      expect(fake.sourceUpserts).toHaveLength(1);
    }),
  );

  it.effect("reactivates unchanged rows only when source state drifted", () =>
    Effect.gen(function* () {
      const unchangedHash = computeContentHash(baseTool);
      const fake = makeDb([
        {
          tool_id: baseTool.toolId,
          content_hash: unchangedHash,
          source_enabled: false,
          source_status: "disconnected",
        },
      ]);

      const result = yield* indexSource({
        sourceId: baseTool.sourceId,
        sourceKey: baseTool.sourceKey,
        source: baseSource,
        tools: [baseTool],
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(SqliteDrizzle, fake.db as never),
            Layer.succeed(SqlClient.SqlClient, makeSql as never),
          ),
        ),
      );

      expect(result.changedTools).toEqual([]);
      expect(fake.updates).toEqual([
        {
          source_enabled: true,
          source_status: "connected",
        },
      ]);
      expect(fake.toolInserts).toEqual([]);
      expect(fake.sourceUpserts).toHaveLength(1);
    }),
  );

  it.effect("upserts the parent source row before inserting catalog tools", () =>
    Effect.gen(function* () {
      const fake = makeDb([]);

      const result = yield* indexSource({
        sourceId: baseTool.sourceId,
        sourceKey: baseTool.sourceKey,
        source: baseSource,
        tools: [baseTool],
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(SqliteDrizzle, fake.db as never),
            Layer.succeed(SqlClient.SqlClient, makeSql as never),
          ),
        ),
      );

      expect(result.changedTools).toEqual([baseTool]);
      expect(fake.operations.slice(0, 2)).toEqual([
        "source-upsert",
        "tool-insert",
      ]);
      expect(fake.sourceUpserts).toEqual([
        {
          values: {
            id: baseSource.sourceId,
            workspace_id: baseSource.workspaceId,
            name: baseSource.name,
            kind: baseSource.kind,
            endpoint: baseSource.endpoint,
            status: baseSource.status,
            enabled: baseSource.enabled,
            namespace: baseSource.namespace,
            time_created: baseSource.createdAt,
            time_updated: baseSource.updatedAt,
          },
          set: {
            workspace_id: baseSource.workspaceId,
            name: baseSource.name,
            kind: baseSource.kind,
            endpoint: baseSource.endpoint,
            status: baseSource.status,
            enabled: baseSource.enabled,
            namespace: baseSource.namespace,
            time_updated: baseSource.updatedAt,
          },
        },
      ]);
      expect(fake.toolInserts).toHaveLength(1);
    }),
  );
});
