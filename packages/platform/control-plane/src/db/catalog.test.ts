import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";
import { SqlClient } from "@effect/sql";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vitest";

import { createSqliteToolCatalog } from "./catalog";
import { VecService, type VecServiceShape } from "./vec";

type CatalogRow = {
  path: string
  namespace: string
  sourceKey: string
  description: string | null
  interaction: string | null
  inputTypePreview: string | null
  outputTypePreview: string | null
  inputSchemaJson: unknown
  outputSchemaJson: unknown
  providerKind: string | null
  sourceEnabled: boolean
  sourceStatus: string | null
}

const flattenQueryChunks = (node: unknown): Array<unknown> => {
  if (
    node !== null &&
    node !== undefined &&
    typeof node === "object" &&
    "queryChunks" in node &&
    Array.isArray((node as { queryChunks: Array<unknown> }).queryChunks)
  ) {
    return (node as { queryChunks: Array<unknown> }).queryChunks.flatMap(
      flattenQueryChunks,
    )
  }

  if (
    node !== null &&
    node !== undefined &&
    typeof node === "object" &&
    "value" in node &&
    Array.isArray((node as { value: Array<unknown> }).value)
  ) {
    return (node as { value: Array<unknown> }).value.flatMap(flattenQueryChunks)
  }

  return [node]
}

const extractEqualsConditions = (condition: unknown): Map<string, unknown> => {
  const flattened = flattenQueryChunks(condition)
  const conditions = new Map<string, unknown>()

  for (let index = 0; index < flattened.length - 2; index += 1) {
    const left = flattened[index]
    const operator = flattened[index + 1]
    const right = flattened[index + 2]

    if (
      left !== null &&
      left !== undefined &&
      typeof left === "object" &&
      "name" in left &&
      typeof (left as { name: unknown }).name === "string" &&
      operator !== null &&
      operator !== undefined &&
      typeof operator === "string" &&
      operator.trim() === "=" &&
      right !== null &&
      right !== undefined &&
      typeof right === "object" &&
      "value" in right
    ) {
      conditions.set(
        (left as { name: string }).name,
        (right as { value: unknown }).value,
      )
    }
  }

  return conditions
}

const matchesConditions = (
  row: CatalogRow,
  conditions: Map<string, unknown>,
): boolean =>
  Array.from(conditions.entries()).every(([key, value]) => {
    switch (key) {
      case "path":
        return row.path === value
      case "namespace":
        return row.namespace === value
      case "source_enabled":
        return row.sourceEnabled === value
      case "source_status":
        return row.sourceStatus === value
      default:
        return true
    }
  })

const makeVecLayer = (overrides: {
  hasVecTable?: VecServiceShape["hasVecTable"]
  searchVec?: VecServiceShape["searchVec"]
} = {}) => {
  const hasVecTable =
    overrides.hasVecTable ?? vi.fn(() => Effect.succeed(true))
  const searchVec =
    overrides.searchVec ?? vi.fn(() => Effect.succeed([] as readonly { toolId: string; score: number }[]))

  return {
    hasVecTable,
    searchVec,
    layer: Layer.succeed(VecService, {
      hasVecTable,
      setupVecTable: () => Effect.void,
      getVecTableDimensions: Effect.succeed(null),
      dropVecTable: Effect.void,
      searchVec,
      upsertVecTool: () => Effect.void,
      removeVecSourceTools: () => Effect.void,
      removeVecTools: () => Effect.void,
    } satisfies VecServiceShape),
  }
}

const makeFakeDb = (rows: readonly CatalogRow[]) => ({
  select: (fields: Record<string, unknown>) => ({
    from: () => ({
      where: (condition: unknown) => ({
        limit: (limit: number) => {
          const filteredRows = rows
            .filter((row) =>
              matchesConditions(row, extractEqualsConditions(condition)),
            )
            .slice(0, limit)

          if ("toolCount" in fields) {
            return Effect.succeed(
              Array.from(
                filteredRows.reduce((acc, row) => {
                  acc.set(row.namespace, (acc.get(row.namespace) ?? 0) + 1)
                  return acc
                }, new Map<string, number>()),
              ).map(([namespace, toolCount]) => ({
                namespace,
                toolCount,
              })),
            )
          }

          return Effect.succeed(
            filteredRows.map((row) => ({
              path: row.path,
              sourceKey: row.sourceKey,
              description: row.description,
              interaction: row.interaction,
              inputTypePreview: row.inputTypePreview,
              outputTypePreview: row.outputTypePreview,
              inputSchemaJson: row.inputSchemaJson,
              outputSchemaJson: row.outputSchemaJson,
              providerKind: row.providerKind,
            })),
          )
        },
        groupBy: () => ({
          limit: (limit: number) => {
            const filteredRows = rows.filter((row) =>
              matchesConditions(row, extractEqualsConditions(condition))
            )

            return Effect.succeed(
              Array.from(
                filteredRows.reduce((acc, row) => {
                  acc.set(row.namespace, (acc.get(row.namespace) ?? 0) + 1)
                  return acc
                }, new Map<string, number>()),
              )
                .slice(0, limit)
                .map(([namespace, toolCount]) => ({
                  namespace,
                  toolCount,
                })),
            )
          },
        }),
      }),
    }),
  }),
})

const makeCatalog = (rows: readonly CatalogRow[]) =>
  createSqliteToolCatalog().pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(SqliteDrizzle, makeFakeDb(rows) as never),
        Layer.succeed(SqlClient.SqlClient, {} as never),
        makeVecLayer().layer,
      ),
    ),
  )

const makeSearchCatalog = (input: {
  rows: readonly Array<{ path: string; raw_score: number }>
  embedder?: {
    provider: string
    model: string
    dimensions: number
    embed: (text: string, hint?: "document" | "query") => Promise<number[]>
    embedBatch: (texts: string[], hint?: "document" | "query") => Promise<number[][]>
  }
  onUnsafe?: (query: string, params: ReadonlyArray<unknown>) => void
  vecLayer?: ReturnType<typeof makeVecLayer>
}) =>
  createSqliteToolCatalog(input.embedder as never).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(SqliteDrizzle, {} as never),
        Layer.succeed(SqlClient.SqlClient, {
          unsafe: (query: string, params: ReadonlyArray<unknown>) => {
            input.onUnsafe?.(query, params)
            return Effect.succeed(input.rows)
          },
        } as never),
        (input.vecLayer ?? makeVecLayer()).layer,
      ),
    ),
  )

describe("sqlite catalog", () => {
  const rows: readonly CatalogRow[] = [
    {
      path: "github.connected",
      namespace: "github",
      sourceKey: "github",
      description: "Connected tool",
      interaction: "auto",
      inputTypePreview: null,
      outputTypePreview: null,
      inputSchemaJson: null,
      outputSchemaJson: null,
      providerKind: null,
      sourceEnabled: true,
      sourceStatus: "connected",
    },
    {
      path: "github.disconnected",
      namespace: "github",
      sourceKey: "github",
      description: "Disconnected tool",
      interaction: "auto",
      inputTypePreview: null,
      outputTypePreview: null,
      inputSchemaJson: null,
      outputSchemaJson: null,
      providerKind: null,
      sourceEnabled: true,
      sourceStatus: "error",
    },
    {
      path: "github.disabled",
      namespace: "github",
      sourceKey: "github",
      description: "Disabled tool",
      interaction: "auto",
      inputTypePreview: null,
      outputTypePreview: null,
      inputSchemaJson: null,
      outputSchemaJson: null,
      providerKind: null,
      sourceEnabled: false,
      sourceStatus: "connected",
    },
  ]

  it.effect("listTools excludes disabled and disconnected sources on the Drizzle path", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog(rows)
      const tools = yield* catalog.listTools({ limit: 10 })

      expect(tools.map((tool) => tool.path)).toEqual(["github.connected"])
    }),
  )

  it.effect("getToolByPath excludes disabled and disconnected sources", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog(rows)

      const connected = yield* catalog.getToolByPath({
        path: "github.connected",
        includeSchemas: false,
      })
      const disconnected = yield* catalog.getToolByPath({
        path: "github.disconnected",
        includeSchemas: false,
      })
      const disabled = yield* catalog.getToolByPath({
        path: "github.disabled",
        includeSchemas: false,
      })

      expect(connected?.path).toBe("github.connected")
      expect(disconnected).toBeNull()
      expect(disabled).toBeNull()
    }),
  )

  it.effect("listNamespaces excludes disabled and disconnected sources", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog([
        ...rows,
        {
          path: "slack.messages.send",
          namespace: "slack.messages",
          sourceKey: "slack",
          description: "Slack tool",
          interaction: "auto",
          inputTypePreview: null,
          outputTypePreview: null,
          inputSchemaJson: null,
          outputSchemaJson: null,
          providerKind: null,
          sourceEnabled: true,
          sourceStatus: "connected",
        },
        {
          path: "slack.messages.archived",
          namespace: "slack.messages",
          sourceKey: "slack",
          description: "Disconnected Slack tool",
          interaction: "auto",
          inputTypePreview: null,
          outputTypePreview: null,
          inputSchemaJson: null,
          outputSchemaJson: null,
          providerKind: null,
          sourceEnabled: true,
          sourceStatus: "error",
        },
      ])

      const namespaces = yield* catalog.listNamespaces({ limit: 10 })

      expect(namespaces).toEqual([
        { namespace: "github", toolCount: 1 },
        { namespace: "slack.messages", toolCount: 1 },
      ])
    }),
  )
})

describe("sqlite catalog searchTools", () => {
  it.effect("tokenizes non-ASCII queries for FTS instead of collapsing them", () =>
    Effect.gen(function* () {
      let capturedParams: ReadonlyArray<unknown> | null = null
      const catalog = yield* makeSearchCatalog({
        rows: [
          { path: "github.issues.create", raw_score: -0.25 },
        ],
        onUnsafe: (_query, params) => {
          capturedParams = params
        },
      })

      const results = yield* catalog.searchTools({
        query: "問題を作成",
        limit: 5,
      })

      expect(results.map((result) => result.path)).toEqual(["github.issues.create"])
      expect(capturedParams?.[0]).toBe("\"問題を作成\"")
    }),
  )

  it.effect("falls back to semantic search when the FTS query is empty but an embedder exists", () =>
    Effect.gen(function* () {
      const vecLayer = makeVecLayer({
        hasVecTable: vi.fn(() => Effect.succeed(true)),
        searchVec: vi.fn(() =>
          Effect.succeed([{ toolId: "github.issues.create", score: 0.7 }]),
        ),
      })

      const embedder = {
        provider: "local",
        model: "test-model",
        dimensions: 3,
        embed: async () => [1, 2, 3],
        embedBatch: async () => [[1, 2, 3]],
      }

      const catalog = yield* makeSearchCatalog({
        rows: [],
        embedder,
        vecLayer,
      })

      const results = yield* catalog.searchTools({
        query: "!!!",
        limit: 5,
      })

      expect(results).toHaveLength(1)
      expect(results[0]?.path).toBe("github.issues.create")
      expect(results[0]?.score).toBeGreaterThan(0)
      expect(vecLayer.searchVec).toHaveBeenCalledTimes(1)
    }),
  )

  it.effect("skips semantic search when FTS already has a dominant lexical match", () =>
    Effect.gen(function* () {
      const vecLayer = makeVecLayer({
        hasVecTable: vi.fn(() => Effect.succeed(true)),
        searchVec: vi.fn(() => Effect.succeed([])),
      })

      const embedder = {
        provider: "local",
        model: "test-model",
        dimensions: 3,
        embed: async () => [1, 2, 3],
        embedBatch: async () => [[1, 2, 3]],
      }

      const catalog = yield* makeSearchCatalog({
        rows: [
          { path: "github.issues.create", raw_score: -10 },
          { path: "github.issues.update", raw_score: -0.5 },
        ],
        embedder,
        vecLayer,
      })

      const results = yield* catalog.searchTools({
        query: "github issues create",
        limit: 5,
      })

      expect(results.map((result) => result.path)).toEqual(["github.issues.create", "github.issues.update"])
      expect(vecLayer.searchVec).not.toHaveBeenCalled()
      expect(results[0]!.score).toBeGreaterThan(results[1]!.score)
      expect(results[0]!.score).toBeGreaterThan(0.85)
    }),
  )

  it.effect("surfaces semantic embedding failures instead of silently falling back", () =>
    Effect.gen(function* () {
      const vecLayer = makeVecLayer({
        hasVecTable: vi.fn(() => Effect.succeed(true)),
      })

      const embedder = {
        provider: "local",
        model: "test-model",
        dimensions: 3,
        embed: async () => {
          throw new Error("embed failed")
        },
        embedBatch: async () => [[1, 2, 3]],
      }

      const catalog = yield* makeSearchCatalog({
        rows: [
          { path: "github.issues.create", raw_score: -0.25 },
        ],
        embedder,
        vecLayer,
      })

      yield* Effect.flip(
        catalog.searchTools({
          query: "create github issue",
          limit: 5,
        }),
      ).pipe(
        Effect.map((error) => {
          expect(error).toBeInstanceOf(Error)
          expect((error as Error).message).toContain("embed failed")
        }),
      )
    }),
  )

  it.effect("returns lexical results when sqlite-vec is unavailable", () =>
    Effect.gen(function* () {
      const vecLayer = makeVecLayer({
        hasVecTable: vi.fn(() => Effect.succeed(false)),
      })

      const embedder = {
        provider: "local",
        model: "test-model",
        dimensions: 3,
        embed: async () => [1, 2, 3],
        embedBatch: async () => [[1, 2, 3]],
      }

      const catalog = yield* makeSearchCatalog({
        rows: [
          { path: "github.issues.create", raw_score: -0.6 },
          { path: "github.issues.update", raw_score: -0.2 },
        ],
        embedder,
        vecLayer,
      })

      const results = yield* catalog.searchTools({
        query: "github issues",
        limit: 5,
      })

      expect(results.map((result) => result.path)).toEqual([
        "github.issues.create",
        "github.issues.update",
      ])
      expect(results.searchMode).toBe("fts")
      expect(vecLayer.searchVec).not.toHaveBeenCalled()
    }),
  )

  it.effect("uses direct bm25 ordering instead of abs() inversion", () =>
    Effect.gen(function* () {
      let capturedQuery: string | null = null
      const catalog = yield* makeSearchCatalog({
        rows: [],
        onUnsafe: (query) => {
          capturedQuery = query
        },
      })

      yield* catalog.searchTools({
        query: "github issues create",
        limit: 5,
      })

      expect(capturedQuery).toContain("bm25(catalog_tool_fts, 10.0, 8.0, 2.0, 1.0) as raw_score")
      expect(capturedQuery).toContain("ORDER BY raw_score ASC")
      expect(capturedQuery).not.toContain("abs(bm25")
    }),
  )
})
