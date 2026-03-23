import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite"
import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"

import type {
  SourceId,
  SourceKind,
  SourceStatus,
  WorkspaceId,
} from "#schema"

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
  name: string
  kind: SourceKind
  endpoint: string
  status: SourceStatus
  enabled: boolean
  namespace: string | null
  createdAt: number
  updatedAt: number
}

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

export const upsertSourceStatus = (input: {
  sourceId: SourceId
  workspaceId: WorkspaceId
  name: string
  kind: SourceKind
  endpoint: string
  status: SourceStatus
  enabled: boolean
  namespace: string | null
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
      name: input.name,
      kind: input.kind,
      endpoint: input.endpoint,
      status: input.status,
      enabled: input.enabled,
      namespace: input.namespace,
      sourceHash: input.sourceHash,
      lastError: input.lastError,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    }).onConflictDoUpdate({
      target: source.id,
      set: {
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
      name: input.source.name,
      kind: input.source.kind,
      endpoint: input.source.endpoint,
      status: input.source.status,
      enabled: input.source.enabled,
      namespace: input.source.namespace,
      createdAt: input.source.createdAt,
      updatedAt: input.source.updatedAt,
    } satisfies typeof source.$inferInsert

    yield* db.insert(source).values(sourceRow).onConflictDoUpdate({
      target: source.id,
      set: {
        workspaceId: input.source.workspaceId,
        name: input.source.name,
        kind: input.source.kind,
        endpoint: input.source.endpoint,
        status: input.source.status,
        enabled: input.source.enabled,
        namespace: input.source.namespace,
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
