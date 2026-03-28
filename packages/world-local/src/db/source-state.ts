import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite"
import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"

import type {
  SourceId,
  SourceStatus,
  SourceCatalogId,
  SourceCatalogRevisionId,
  WorkspaceId,
} from "@executor/core/model"

import { catalog_tool, source } from "./schema"

export type SourceStatusRecord = {
  status: SourceStatus
  lastError: string | null
  sourceHash: string | null
  createdAt: number
  updatedAt: number
}

export type SourceLifecycleRecord = {
  sourceId: SourceId
  workspaceId: WorkspaceId
  catalogId: SourceCatalogId | null
  catalogRevisionId: SourceCatalogRevisionId | null
  status: SourceStatus
  enabled: boolean
  sourceHash: string | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

const selectSourceLifecycle = {
  sourceId: source.id,
  workspaceId: source.workspaceId,
  catalogId: source.catalogId,
  catalogRevisionId: source.catalogRevisionId,
  status: source.status,
  enabled: source.enabled,
  sourceHash: source.sourceHash,
  lastError: source.lastError,
  createdAt: source.createdAt,
  updatedAt: source.updatedAt,
} as const

export const loadSourceStatus = (
  sourceId: SourceId,
) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle
    const rows = yield* db
      .select({
        status: source.status,
        lastError: source.lastError,
        sourceHash: source.sourceHash,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
      })
      .from(source)
      .where(eq(source.id, sourceId))
      .limit(1)

    if (rows.length === 0) {
      return null
    }

    return rows[0] as SourceStatusRecord
  })

export const loadSourceLifecycle = (
  sourceId: SourceId,
) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle
    const rows = yield* db
      .select(selectSourceLifecycle)
      .from(source)
      .where(eq(source.id, sourceId))
      .limit(1)

    if (rows.length === 0) {
      return null
    }

    return rows[0] as SourceLifecycleRecord
  })

export const listSourceLifecycles = (
  workspaceId: WorkspaceId,
) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle
    const rows = yield* db
      .select(selectSourceLifecycle)
      .from(source)
      .where(eq(source.workspaceId, workspaceId))

    return rows as ReadonlyArray<SourceLifecycleRecord>
  })

export const upsertSourceStatus = (input: {
  sourceId: SourceId
  workspaceId: WorkspaceId
  catalogId?: SourceCatalogId | null
  catalogRevisionId?: SourceCatalogRevisionId | null
  status: SourceStatus
  enabled: boolean
  lastError: string | null
  sourceHash: string | null
  createdAt: number
  updatedAt: number
}) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle

    yield* db.insert(source).values({
      id: input.sourceId,
      workspaceId: input.workspaceId,
      catalogId: input.catalogId ?? null,
      catalogRevisionId: input.catalogRevisionId ?? null,
      status: input.status,
      enabled: input.enabled,
      sourceHash: input.sourceHash,
      lastError: input.lastError,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    }).onConflictDoUpdate({
      target: source.id,
      set: {
        catalogId: input.catalogId ?? null,
        catalogRevisionId: input.catalogRevisionId ?? null,
        status: input.status,
        enabled: input.enabled,
        lastError: input.lastError,
        sourceHash: input.sourceHash,
        updatedAt: input.updatedAt,
      },
    })
  })

export const syncSourceLifecycle = (input: {
  sourceId: SourceId
  source: SourceLifecycleRecord
}) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle

    const sourceRow = {
      id: input.source.sourceId,
      workspaceId: input.source.workspaceId,
      catalogId: input.source.catalogId,
      catalogRevisionId: input.source.catalogRevisionId,
      status: input.source.status,
      enabled: input.source.enabled,
      sourceHash: input.source.sourceHash,
      lastError: input.source.lastError,
      createdAt: input.source.createdAt,
      updatedAt: input.source.updatedAt,
    } satisfies typeof source.$inferInsert

    yield* db.insert(source).values(sourceRow).onConflictDoUpdate({
      target: source.id,
      set: {
        workspaceId: input.source.workspaceId,
        catalogId: input.source.catalogId,
        catalogRevisionId: input.source.catalogRevisionId,
        status: input.source.status,
        enabled: input.source.enabled,
        sourceHash: input.source.sourceHash,
        lastError: input.source.lastError,
        updatedAt: input.source.updatedAt,
      },
    })

    yield* db
      .update(catalog_tool)
      .set({
        sourceEnabled: input.source.enabled,
        sourceStatus: input.source.status,
      })
      .where(eq(catalog_tool.sourceId, input.sourceId as typeof catalog_tool.$inferInsert.sourceId))
  })

export const removeSource = (sourceId: SourceId) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle

    yield* db.delete(source).where(eq(source.id, sourceId))
  })
