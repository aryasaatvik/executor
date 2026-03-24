import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import { makeDatabaseLive, loadSqliteVecExtension } from "./client"
import { setupCatalogToolFts } from "./fts"
import { applyDrizzleMigrations } from "./migrator"
import { setupVecTable, getVecTableDimensions, dropVecTable, VecLive } from "./vec"

const sqliteVecRequiredError = (context: string) =>
  new Error(
    `sqlite-vec is required for ${context} when embeddings are configured, but the extension could not be loaded.`,
  )

const ensureSqliteVecExtensionLoaded = (
  loadExtension: typeof loadSqliteVecExtension,
  context: string,
) =>
  loadExtension.pipe(
    Effect.flatMap((loaded) =>
      loaded
        ? Effect.void
        : Effect.fail(sqliteVecRequiredError(context)),
    ),
  )

/**
 * Apply schema migrations and custom SQLite bootstrap that Drizzle does not model.
 *
 * Table and index DDL come from Drizzle migration files. This setup step only
 * applies those migrations, then provisions custom SQLite artifacts like FTS5
 * virtual tables / triggers and sqlite-vec.
 */
const runSetup = (options?: {
  embeddingDimensions?: number
  loadSqliteVecExtension?: typeof loadSqliteVecExtension
}) => Effect.gen(function* () {
  yield* applyDrizzleMigrations

  // -----------------------------------------------------------------------
  // FTS5 virtual table + sync triggers
  // -----------------------------------------------------------------------
  yield* setupCatalogToolFts

  // -----------------------------------------------------------------------
  // sqlite-vec: vector table (required when embeddings are configured)
  // -----------------------------------------------------------------------
  if (options?.embeddingDimensions) {
    yield* ensureSqliteVecExtensionLoaded(
      options.loadSqliteVecExtension ?? loadSqliteVecExtension,
      "sqlite-backed semantic search",
    )

    // Check if existing vec table has mismatched dimensions
    const existingDims = yield* getVecTableDimensions

    if (existingDims !== null && existingDims !== options.embeddingDimensions) {
      yield* Effect.logWarning(
        `Vec table dimension mismatch: existing=${existingDims}, configured=${options.embeddingDimensions}. Recreating vec table.`,
      )
      yield* dropVecTable
    }

    yield* setupVecTable(options.embeddingDimensions)
  }
})

/**
 * Create the full database layer for the workspace catalog, including
 * Drizzle schema migrations, FTS5 setup, and optional sqlite-vec vector table
 * setup.
 *
 * Usage:
 * ```ts
 * const dbLayer = makeWorkspaceCatalogDbLayer(dbPath)
 * const catalog = yield* createSqliteToolCatalog().pipe(Effect.provide(dbLayer))
 * ```
 *
 * To enable vector search (sqlite-vec), pass embedding dimensions:
 * ```ts
 * const dbLayer = makeWorkspaceCatalogDbLayer(dbPath, {
 *   embeddingDimensions: 768,
 * })
 * ```
 */
export const makeWorkspaceCatalogDbLayer = (
  filename: string,
  options?: {
    embeddingDimensions?: number
    loadSqliteVecExtension?: typeof loadSqliteVecExtension
  },
) => {
  const dbLive = makeDatabaseLive(filename)
  const dbWithVecLive = Layer.mergeAll(dbLive, VecLive)

  const migrationLayer = Layer.effectDiscard(runSetup(options)).pipe(
    Layer.provideMerge(dbWithVecLive),
  )

  return migrationLayer
}

/**
 * Create a lightweight query layer for the workspace catalog.
 *
 * Unlike `makeWorkspaceCatalogDbLayer`, this opens the SQLite connection and
 * loads sqlite-vec when needed, but intentionally does not rerun schema setup
 * or JSON migration work on every query.
 */
export const makeWorkspaceCatalogQueryDbLayer = (
  filename: string,
  options?: {
    embeddingDimensions?: number
    loadSqliteVecExtension?: typeof loadSqliteVecExtension
  },
) => {
  const dbLive = makeDatabaseLive(filename)
  const queryBaseLayer = Layer.mergeAll(dbLive, VecLive)

  if (!options?.embeddingDimensions) {
    return queryBaseLayer
  }

  return Layer.effectDiscard(
    ensureSqliteVecExtensionLoaded(
      options.loadSqliteVecExtension ?? loadSqliteVecExtension,
      "the workspace catalog query layer",
    ),
  ).pipe(Layer.provideMerge(queryBaseLayer))
}
