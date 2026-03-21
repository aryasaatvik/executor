import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";
import { SqlClient } from "@effect/sql";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { createSqliteToolCatalog } from "./catalog";

type CatalogRow = {
  path: string
  namespace: string
  source_key: string
  description: string | null
  interaction: string | null
  input_type_preview: string | null
  output_type_preview: string | null
  input_schema_json: unknown
  output_schema_json: unknown
  provider_kind: string | null
  source_enabled: boolean
  source_status: string | null
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
      case "source_enabled":
        return row.source_enabled === value
      case "source_status":
        return row.source_status === value
      default:
        return true
    }
  })

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

          if ("tool_count" in fields) {
            return Effect.succeed(
              Array.from(
                filteredRows.reduce((acc, row) => {
                  acc.set(row.namespace, (acc.get(row.namespace) ?? 0) + 1)
                  return acc
                }, new Map<string, number>()),
              ).map(([namespace, tool_count]) => ({
                namespace,
                tool_count,
              })),
            )
          }

          return Effect.succeed(
            filteredRows.map((row) => ({
              path: row.path,
              source_key: row.source_key,
              description: row.description,
              interaction: row.interaction,
              input_type_preview: row.input_type_preview,
              output_type_preview: row.output_type_preview,
              input_schema_json: row.input_schema_json,
              output_schema_json: row.output_schema_json,
              provider_kind: row.provider_kind,
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
                .map(([namespace, tool_count]) => ({
                  namespace,
                  tool_count,
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
      ),
    ),
  )

describe("sqlite catalog", () => {
  const rows: readonly CatalogRow[] = [
    {
      path: "github.connected",
      namespace: "github",
      source_key: "github",
      description: "Connected tool",
      interaction: "auto",
      input_type_preview: null,
      output_type_preview: null,
      input_schema_json: null,
      output_schema_json: null,
      provider_kind: null,
      source_enabled: true,
      source_status: "connected",
    },
    {
      path: "github.disconnected",
      namespace: "github",
      source_key: "github",
      description: "Disconnected tool",
      interaction: "auto",
      input_type_preview: null,
      output_type_preview: null,
      input_schema_json: null,
      output_schema_json: null,
      provider_kind: null,
      source_enabled: true,
      source_status: "error",
    },
    {
      path: "github.disabled",
      namespace: "github",
      source_key: "github",
      description: "Disabled tool",
      interaction: "auto",
      input_type_preview: null,
      output_type_preview: null,
      input_schema_json: null,
      output_schema_json: null,
      provider_kind: null,
      source_enabled: false,
      source_status: "connected",
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
          source_key: "slack",
          description: "Slack tool",
          interaction: "auto",
          input_type_preview: null,
          output_type_preview: null,
          input_schema_json: null,
          output_schema_json: null,
          provider_kind: null,
          source_enabled: true,
          source_status: "connected",
        },
        {
          path: "slack.messages.archived",
          namespace: "slack.messages",
          source_key: "slack",
          description: "Disconnected Slack tool",
          interaction: "auto",
          input_type_preview: null,
          output_type_preview: null,
          input_schema_json: null,
          output_schema_json: null,
          provider_kind: null,
          source_enabled: true,
          source_status: "error",
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
