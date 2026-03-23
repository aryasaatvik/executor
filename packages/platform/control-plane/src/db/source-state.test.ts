import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import { SourceIdSchema, WorkspaceIdSchema } from "#schema"

import {
  loadSourceStatus,
  removeSource,
  syncSourceLifecycle,
  type SourceLifecycleRecord,
  upsertSourceStatus,
  type SourceStatusRecord,
} from "./source-state"

const baseSource: SourceLifecycleRecord = {
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
}

describe("loadSourceStatus", () => {
  it.effect("returns null when the source does not exist", () =>
    Effect.gen(function* () {
      const db = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Effect.succeed([]),
            }),
          }),
        }),
      }

      const result = yield* loadSourceStatus(
        SourceIdSchema.make("missing-source"),
      ).pipe(
        Effect.provide(Layer.succeed(SqliteDrizzle, db as never)),
      )

      expect(result).toBeNull()
    }),
  )

  it.effect("returns source status when the source exists", () =>
    Effect.gen(function* () {
      const statusRow: SourceStatusRecord = {
        status: "connected",
        lastError: null,
        sourceHash: "abc123",
        createdAt: 1000,
        updatedAt: 2000,
      }
      const db = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Effect.succeed([statusRow]),
            }),
          }),
        }),
      }

      const result = yield* loadSourceStatus(
        SourceIdSchema.make("existing-source"),
      ).pipe(
        Effect.provide(Layer.succeed(SqliteDrizzle, db as never)),
      )

      expect(result).toEqual(statusRow)
    }),
  )
})

describe("upsertSourceStatus", () => {
  it.effect("inserts source status with conflict update", () =>
    Effect.gen(function* () {
      const inserted: Array<Record<string, unknown>> = []
      const conflictSets: Array<Record<string, unknown>> = []
      const db = {
        insert: () => ({
          values: (values: Record<string, unknown>) => ({
            onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => {
              inserted.push(values)
              conflictSets.push(set)
              return Effect.void
            },
          }),
        }),
      }

      yield* upsertSourceStatus({
        sourceId: SourceIdSchema.make("src-1"),
        workspaceId: WorkspaceIdSchema.make("ws-1"),
        name: "Test Source",
        kind: "mcp",
        endpoint: "https://example.com",
        status: "connected",
        enabled: true,
        namespace: "test",
        lastError: null,
        sourceHash: "hash-abc",
        createdAt: 1000,
        updatedAt: 2000,
      }).pipe(
        Effect.provide(Layer.succeed(SqliteDrizzle, db as never)),
      )

      expect(inserted).toHaveLength(1)
      expect(inserted[0]).toMatchObject({
        name: "Test Source",
        kind: "mcp",
        status: "connected",
        enabled: true,
      })
      expect(conflictSets[0]).toMatchObject({
        status: "connected",
        enabled: true,
        sourceHash: "hash-abc",
        updatedAt: 2000,
      })
    }),
  )
})

describe("removeSource", () => {
  it.effect("deletes the source row", () =>
    Effect.gen(function* () {
      let deleteCalled = false
      const db = {
        delete: () => ({
          where: () => {
            deleteCalled = true
            return Effect.void
          },
        }),
      }

      yield* removeSource(
        SourceIdSchema.make("src-to-remove"),
      ).pipe(
        Effect.provide(Layer.succeed(SqliteDrizzle, db as never)),
      )

      expect(deleteCalled).toBe(true)
    }),
  )
})

describe("syncSourceLifecycle", () => {
  it.effect("upserts source row and updates tool lifecycle flags", () =>
    Effect.gen(function* () {
      const sourceUpserts: Array<{
        values: Record<string, unknown>
        set: Record<string, unknown>
      }> = []
      const toolUpdates: Array<Record<string, unknown>> = []
      const db = {
        insert: () => ({
          values: (values: Record<string, unknown>) => ({
            onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => {
              sourceUpserts.push({ values, set })
              return Effect.void
            },
          }),
        }),
        update: () => ({
          set: (values: Record<string, unknown>) => ({
            where: () => {
              toolUpdates.push(values)
              return Effect.void
            },
          }),
        }),
      }

      const sourceData: SourceToIndex = {
        ...baseSource,
        status: "error",
        enabled: false,
      }

      yield* syncSourceLifecycle({
        sourceId: sourceData.sourceId,
        source: sourceData,
      }).pipe(
        Effect.provide(Layer.succeed(SqliteDrizzle, db as never)),
      )

      expect(sourceUpserts).toHaveLength(1)
      expect(sourceUpserts[0].values.status).toBe("error")
      expect(sourceUpserts[0].values.enabled).toBe(false)

      expect(toolUpdates).toHaveLength(1)
      expect(toolUpdates[0]).toEqual({
        sourceEnabled: false,
        sourceStatus: "error",
      })
    }),
  )
})
