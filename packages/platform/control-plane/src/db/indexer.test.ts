import { createHash } from "node:crypto";
import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";
import { SqlClient } from "@effect/sql";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vitest";

import { buildSearchText, indexSource, type ToolToIndex } from "./indexer";

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
  description: "Create a GitHub issue",
};

const makeDb = (existingRows: Array<{
  tool_id: string;
  content_hash: string;
  source_enabled: boolean;
  source_status: string | null;
}>) => {
  const updates: Array<Record<string, unknown>> = [];
  const inserts: Array<Record<string, unknown>> = [];

  return {
    updates,
    inserts,
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
            return Effect.void;
          },
        }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          inserts.push(values);
          return Effect.void;
        },
      }),
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
      expect(fake.inserts).toEqual([]);
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
      expect(fake.inserts).toEqual([]);
    }),
  );
});
