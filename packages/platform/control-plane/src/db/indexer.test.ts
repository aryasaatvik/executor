import { createHash } from "node:crypto";
import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";
import { SqlClient } from "@effect/sql";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vitest";

import { SourceIdSchema, WorkspaceIdSchema } from "#schema";
import {
  buildSearchText,
  indexSource,
  hasSourceCatalogData,
  loadSemanticSearchSignature,
  writeSemanticSearchSignature,
  deactivateSourceTools,
  loadToolForInvocation,
  type SourceToIndex,
  type ToolToIndex,
} from "./indexer";
import { source, catalog_tool, workspace_state } from "./schema";

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
  sourceId: SourceIdSchema.make("source-github"),
  sourceKey: "github",
  namespace: "github.issues",
  searchText: "github github.issues GitHub Create Issue streamable-http oauth",
  description: "Create a GitHub issue",
};

const baseSource: SourceToIndex = {
  sourceId: SourceIdSchema.make("source-github"),
  workspaceId: WorkspaceIdSchema.make("workspace-1"),
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
  toolId: string;
  contentHash: string;
  sourceEnabled: boolean;
  sourceStatus: string | null;
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
          toolId: baseTool.toolId,
          contentHash: unchangedHash,
          sourceEnabled: true,
          sourceStatus: "connected",
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
          toolId: baseTool.toolId,
          contentHash: unchangedHash,
          sourceEnabled: false,
          sourceStatus: "disconnected",
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
          sourceEnabled: true,
          sourceStatus: "connected",
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
            workspaceId: baseSource.workspaceId,
            name: baseSource.name,
            kind: baseSource.kind,
            endpoint: baseSource.endpoint,
            status: baseSource.status,
            enabled: baseSource.enabled,
            namespace: baseSource.namespace,
            createdAt: baseSource.createdAt,
            updatedAt: baseSource.updatedAt,
          },
          set: {
            workspaceId: baseSource.workspaceId,
            name: baseSource.name,
            kind: baseSource.kind,
            endpoint: baseSource.endpoint,
            status: baseSource.status,
            enabled: baseSource.enabled,
            namespace: baseSource.namespace,
            updatedAt: baseSource.updatedAt,
          },
        },
      ]);
      expect(fake.toolInserts).toHaveLength(1);
    }),
  );
});


describe("hasSourceCatalogData", () => {
  it.effect("returns false when no catalog tools exist for the source", () =>
    Effect.gen(function* () {
      const db = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Effect.succeed([]),
            }),
          }),
        }),
      };

      const result = yield* hasSourceCatalogData(
        SourceIdSchema.make("no-catalog-source"),
      ).pipe(
        Effect.provide(Layer.succeed(SqliteDrizzle, db as never)),
      );

      expect(result).toBe(false);
    }),
  );

  it.effect("returns true when catalog tools exist for the source", () =>
    Effect.gen(function* () {
      const db = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Effect.succeed([{ toolId: "some-tool" }]),
            }),
          }),
        }),
      };

      const result = yield* hasSourceCatalogData(
        SourceIdSchema.make("has-catalog-source"),
      ).pipe(
        Effect.provide(Layer.succeed(SqliteDrizzle, db as never)),
      );

      expect(result).toBe(true);
    }),
  );
});

describe("semantic search signature", () => {
  it.effect("loadSemanticSearchSignature returns null when no signature exists", () =>
    Effect.gen(function* () {
      const db = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Effect.succeed([]),
            }),
          }),
        }),
      };

      const result = yield* loadSemanticSearchSignature(
        WorkspaceIdSchema.make("ws-1"),
      ).pipe(
        Effect.provide(Layer.succeed(SqliteDrizzle, db as never)),
      );

      expect(result).toBeNull();
    }),
  );

  it.effect("loadSemanticSearchSignature returns the stored signature", () =>
    Effect.gen(function* () {
      const signature = JSON.stringify({ provider: "openai", model: "text-embedding-3-small", dimensions: 1536 });
      const db = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Effect.succeed([{ value: signature }]),
            }),
          }),
        }),
      };

      const result = yield* loadSemanticSearchSignature(
        WorkspaceIdSchema.make("ws-1"),
      ).pipe(
        Effect.provide(Layer.succeed(SqliteDrizzle, db as never)),
      );

      expect(result).toBe(signature);
    }),
  );

  it.effect("writeSemanticSearchSignature upserts the signature", () =>
    Effect.gen(function* () {
      const written: Array<Record<string, unknown>> = [];
      const db = {
        insert: () => ({
          values: (values: Record<string, unknown>) => ({
            onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => {
              written.push({ ...values, conflictSet: set });
              return Effect.void;
            },
          }),
        }),
      };
      const signature = JSON.stringify({ provider: "openai" });

      yield* writeSemanticSearchSignature(
        WorkspaceIdSchema.make("ws-1"),
        signature,
      ).pipe(
        Effect.provide(Layer.succeed(SqliteDrizzle, db as never)),
      );

      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        workspaceId: "ws-1",
        value: signature,
      });
    }),
  );
});

describe("deactivateSourceTools", () => {
  it.effect("marks all tools for a source as disabled/disconnected", () =>
    Effect.gen(function* () {
      const updates: Array<{ set: Record<string, unknown>; toolId?: string }> = [];
      const db = {
        update: () => ({
          set: (values: Record<string, unknown>) => ({
            where: () => {
              updates.push({ set: values });
              return Effect.void;
            },
          }),
        }),
      };

      yield* deactivateSourceTools(
        SourceIdSchema.make("source-github"),
      ).pipe(
        Effect.provide(Layer.succeed(SqliteDrizzle, db as never)),
      );

      expect(updates).toHaveLength(1);
      expect(updates[0].set).toEqual({
        sourceEnabled: false,
        sourceStatus: "disconnected",
      });
    }),
  );
});


describe("indexSource stale tool removal", () => {
  it.effect("removes stale tools not present in the incoming set", () =>
    Effect.gen(function* () {
      const staleHash = computeContentHash(baseTool);

      const fake = makeDb([
        {
          toolId: baseTool.toolId,
          contentHash: staleHash,
          sourceEnabled: true,
          sourceStatus: "connected",
        },
        {
          toolId: "github.issues.old",
          contentHash: "some-old-hash",
          sourceEnabled: true,
          sourceStatus: "connected",
        },
      ]);

      // Override delete to capture stale removal
      fake.db.delete = (() => ({
        where: () => {
          fake.operations.push("tool-delete");
          return Effect.void;
        },
      })) as typeof fake.db.delete;

      // Provide a SqlClient mock that supports unsafe() for removeVecTools
      const sqlWithUnsafe = {
        withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
        unsafe: () => Effect.succeed([]),
      };

      const result = yield* indexSource({
        sourceId: baseTool.sourceId,
        sourceKey: baseTool.sourceKey,
        source: baseSource,
        tools: [baseTool], // only baseTool, "github.issues.old" is stale
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(SqliteDrizzle, fake.db as never),
            Layer.succeed(SqlClient.SqlClient, sqlWithUnsafe as never),
          ),
        ),
      );

      expect(result.changedTools).toEqual([]);
      expect(fake.operations).toContain("tool-delete");
    }),
  );

  it.effect("inserts changed tools and reports them in changedTools", () =>
    Effect.gen(function* () {
      const changedTool: ToolToIndex = {
        ...baseTool,
        description: "Updated description",
      };

      const fake = makeDb([
        {
          toolId: baseTool.toolId,
          contentHash: "old-hash-that-no-longer-matches",
          sourceEnabled: true,
          sourceStatus: "connected",
        },
      ]);

      const result = yield* indexSource({
        sourceId: baseTool.sourceId,
        sourceKey: baseTool.sourceKey,
        source: baseSource,
        tools: [changedTool],
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(SqliteDrizzle, fake.db as never),
            Layer.succeed(SqlClient.SqlClient, makeSql as never),
          ),
        ),
      );

      expect(result.changedTools).toHaveLength(1);
      expect(result.changedTools[0].description).toBe("Updated description");
      expect(fake.updates).toHaveLength(1);
    }),
  );
});

describe("loadToolForInvocation", () => {
  it.effect("returns null when no tool matches the path", () =>
    Effect.gen(function* () {
      const db = {
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: () => Effect.succeed([]),
              }),
            }),
          }),
        }),
      };

      const result = yield* loadToolForInvocation("nonexistent.tool").pipe(
        Effect.provide(Layer.succeed(SqliteDrizzle, db as never)),
      );

      expect(result).toBeNull();
    }),
  );

  it.effect("returns null when tool exists but has no capabilityJson", () =>
    Effect.gen(function* () {
      const db = {
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: () =>
                  Effect.succeed([
                    {
                      path: "github.issues.create",
                      sourceId: "source-github",
                      sourceKey: "github",
                      namespace: "github.issues",
                      description: "Create a GitHub issue",
                      interaction: "auto",
                      inputSchemaJson: null,
                      outputSchemaJson: null,
                      inputTypePreview: null,
                      outputTypePreview: null,
                      providerKind: null,
                      capabilityJson: null,
                      executableJson: null,
                      sourceEnabled: true,
                      sourceStatus: "connected",
                      catalogRevisionId: null,
                    },
                  ]),
              }),
            }),
          }),
        }),
      };

      const result = yield* loadToolForInvocation("github.issues.create").pipe(
        Effect.provide(Layer.succeed(SqliteDrizzle, db as never)),
      );

      expect(result).toBeNull();
    }),
  );

  it.effect("returns null when tool is disabled", () =>
    Effect.gen(function* () {
      const db = {
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: () =>
                  Effect.succeed([
                    {
                      path: "github.issues.create",
                      sourceId: "source-github",
                      sourceKey: "github",
                      namespace: "github.issues",
                      description: "Create a GitHub issue",
                      interaction: "auto",
                      inputSchemaJson: null,
                      outputSchemaJson: null,
                      inputTypePreview: null,
                      outputTypePreview: null,
                      providerKind: "mcp",
                      capabilityJson: JSON.stringify({ id: "cap-1", surface: {}, executableIds: ["exec-1"] }),
                      executableJson: JSON.stringify({ id: "exec-1", adapterKey: "mcp" }),
                      sourceEnabled: false,
                      sourceStatus: "connected",
                      catalogRevisionId: null,
                    },
                  ]),
              }),
            }),
          }),
        }),
      };

      const result = yield* loadToolForInvocation("github.issues.create").pipe(
        Effect.provide(Layer.succeed(SqliteDrizzle, db as never)),
      );

      expect(result).toBeNull();
    }),
  );

  it.effect("returns full tool data including reconstructed catalog with snapshot", () =>
    Effect.gen(function* () {
      const capability = {
        id: "cap-1",
        surface: { title: "Create Issue", summary: "Create a GitHub issue" },
        executableIds: ["exec-1"],
        preferredExecutableId: "exec-1",
      };
      const executable = { id: "exec-1", adapterKey: "mcp" };
      const snapshotJson = JSON.stringify({
        symbols: { "sym-1": { name: "Owner" } },
        scopes: {},
        responseSets: {},
        resources: {},
        diagnostics: {},
      });

      let selectCallCount = 0;
      const db = {
        select: () => {
          selectCallCount++;
          if (selectCallCount === 1) {
            // First call: catalog_tool + source join
            return {
              from: () => ({
                innerJoin: () => ({
                  where: () => ({
                    limit: () =>
                      Effect.succeed([
                        {
                          path: "github.issues.create",
                          sourceId: "source-github",
                          sourceKey: "github",
                          namespace: "github.issues",
                          description: "Create a GitHub issue",
                          interaction: "auto",
                          inputSchemaJson: { properties: { owner: { type: "string" } } },
                          outputSchemaJson: null,
                          inputTypePreview: "{ owner: string }",
                          outputTypePreview: null,
                          providerKind: "mcp",
                          capabilityJson: JSON.stringify(capability),
                          executableJson: JSON.stringify(executable),
                          sourceEnabled: true,
                          sourceStatus: "connected",
                          catalogRevisionId: "rev-1",
                        },
                      ]),
                  }),
                }),
              }),
            };
          }
          // Second call: catalog_revision snapshot_json
          return {
            from: () => ({
              where: () => ({
                limit: () =>
                  Effect.succeed([{ snapshotJson }]),
              }),
            }),
          };
        },
      };

      const result = yield* loadToolForInvocation("github.issues.create").pipe(
        Effect.provide(Layer.succeed(SqliteDrizzle, db as never)),
      );

      expect(result).not.toBeNull();
      expect(result!.path).toBe("github.issues.create");
      expect(result!.sourceKey).toBe("github");
      expect(result!.capability).toEqual(capability);
      expect(result!.executable).toEqual(executable);
      expect(result!.descriptor.path).toBe("github.issues.create");
      expect(result!.descriptor.sourceKey).toBe("github");
      expect(result!.descriptor.interaction).toBe("auto");
      expect(result!.descriptor.contract?.inputSchema).toEqual({
        properties: { owner: { type: "string" } },
      });
      expect(result!.descriptor.contract?.inputTypePreview).toBe("{ owner: string }");

      // Verify reconstructed catalog has symbols from snapshot_json
      expect(result!.catalog.symbols).toEqual({ "sym-1": { name: "Owner" } });
      expect(result!.catalog.version).toBe("ir.v1");
      expect(result!.catalog.capabilities).toHaveProperty("cap-1");
      expect(result!.catalog.executables).toHaveProperty("exec-1");
    }),
  );

  it.effect("reconstructs catalog with empty snapshot data when no revision found", () =>
    Effect.gen(function* () {
      const capability = {
        id: "cap-1",
        surface: {},
        executableIds: ["exec-1"],
      };
      const executable = { id: "exec-1", adapterKey: "mcp" };

      let selectCallCount = 0;
      const db = {
        select: () => {
          selectCallCount++;
          if (selectCallCount === 1) {
            return {
              from: () => ({
                innerJoin: () => ({
                  where: () => ({
                    limit: () =>
                      Effect.succeed([
                        {
                          path: "slack.send",
                          sourceId: "source-slack",
                          sourceKey: "slack",
                          namespace: "slack",
                          description: null,
                          interaction: "required",
                          inputSchemaJson: null,
                          outputSchemaJson: null,
                          inputTypePreview: null,
                          outputTypePreview: null,
                          providerKind: null,
                          capabilityJson: JSON.stringify(capability),
                          executableJson: JSON.stringify(executable),
                          sourceEnabled: true,
                          sourceStatus: "connected",
                          catalogRevisionId: "rev-missing",
                        },
                      ]),
                  }),
                }),
              }),
            };
          }
          // No revision found
          return {
            from: () => ({
              where: () => ({
                limit: () => Effect.succeed([]),
              }),
            }),
          };
        },
      };

      const result = yield* loadToolForInvocation("slack.send").pipe(
        Effect.provide(Layer.succeed(SqliteDrizzle, db as never)),
      );

      expect(result).not.toBeNull();
      expect(result!.path).toBe("slack.send");
      expect(result!.descriptor.interaction).toBe("required");
      // Snapshot data should be empty objects
      expect(result!.catalog.symbols).toEqual({});
      expect(result!.catalog.scopes).toEqual({});
      expect(result!.catalog.resources).toEqual({});
    }),
  );
});
