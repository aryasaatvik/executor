import { SqliteClient } from "@effect/sql-sqlite-bun"
import { layer as SqliteDrizzleLayer } from "@effect/sql-drizzle/Sqlite"
import { SqlClient } from "@effect/sql"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

// ---------------------------------------------------------------------------
// macOS: swap in Homebrew SQLite before any Database instances are created.
//
// Apple's system SQLite is compiled with SQLITE_OMIT_LOAD_EXTENSION which
// prevents loading native extensions like sqlite-vec.  Calling
// Database.setCustomSQLite() with Homebrew's build lifts that restriction.
//
// This runs at module load time (top-level await) and is a no-op on non-macOS
// or when Homebrew SQLite isn't installed.
// ---------------------------------------------------------------------------
if (process.platform === "darwin" && process.versions.bun && !process.env.VITEST) {
  try {
    const bunSqlite = "bun:" + "sqlite"
    const { Database } = await import(/* @vite-ignore */ bunSqlite)
    const homebrewPaths = [
      "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", // Apple Silicon
      "/usr/local/opt/sqlite/lib/libsqlite3.dylib", // Intel
    ]
    for (const p of homebrewPaths) {
      try {
        Database.setCustomSQLite(p)
        break
      } catch {
        // try next path
      }
    }
  } catch {
    // Not running under Bun, or setCustomSQLite unavailable — ignore.
  }
}

/**
 * Create a SqliteClient layer for the given database filename.
 *
 * @effect/sql-sqlite-bun enables WAL mode by default.
 * We run additional pragmas (busy_timeout, cache_size, foreign_keys)
 * after the connection is established.
 */
/**
 * The canonical database filename for the executor workspace.
 * All runtime state (catalog, auth, executions, secrets, policies, workspace state)
 * lives in this single SQLite file.
 */
export const EXECUTOR_DB_FILENAME = "executor.db"

export const makeSqliteLive = (filename: string) =>
  SqliteClient.layer({ filename })

/**
 * Run additional SQLite pragmas after the client is ready.
 *
 * WAL is already enabled by @effect/sql-sqlite-bun. These pragmas
 * improve concurrency and correctness:
 * - busy_timeout=5000: wait up to 5s when the DB is locked
 * - cache_size=-64000: use ~64MB page cache
 * - foreign_keys=ON: enforce FK constraints
 */
const PragmaLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`PRAGMA busy_timeout = 5000`
    yield* sql`PRAGMA cache_size = -64000`
    yield* sql`PRAGMA foreign_keys = ON`
  }),
)

/**
 * Drizzle layer — wraps SqlClient to provide Drizzle ORM query builder.
 * Drizzle queries become yield*-able Effects.
 */
export const DrizzleLive = SqliteDrizzleLayer

/**
 * Create the full database layer stack for a given filename.
 *
 * Provides:
 * - SqliteClient (bun:sqlite with WAL)
 * - SqlClient.SqlClient (generic SQL client)
 * - SqliteDrizzle (Drizzle ORM query builder)
 */
export const makeDatabaseLive = (filename: string) => {
  const sqliteLive = makeSqliteLive(filename)

  const sqliteWithPragmas = PragmaLayer.pipe(
    Layer.provideMerge(sqliteLive),
  )

  const drizzleLive = DrizzleLive.pipe(
    Layer.provide(sqliteWithPragmas),
  )

  return Layer.mergeAll(sqliteWithPragmas, drizzleLive)
}

// ---------------------------------------------------------------------------
// sqlite-vec extension loading
// ---------------------------------------------------------------------------

/**
 * Load the sqlite-vec extension into the current SqliteClient connection.
 *
 * Uses the `sqlite-vec` npm package's `getLoadablePath()` to locate the
 * native extension binary, then calls `SqliteClient.loadExtension()`.
 *
 * This must be called after the SqliteClient layer is created and before
 * any vec0 virtual table operations.
 *
 * Returns true if the extension was loaded successfully, false otherwise.
 */
export const loadSqliteVecExtension = Effect.gen(function* () {
  const client = yield* SqliteClient.SqliteClient

  const vecModule = yield* Effect.tryPromise({
    try: () => import("sqlite-vec") as Promise<{ getLoadablePath: () => string }>,
    catch: () => new Error("Failed to import sqlite-vec"),
  }).pipe(Effect.option)

  if (vecModule._tag === "None") {
    yield* Effect.logWarning(
      "sqlite-vec package could not be imported. Vector search will be unavailable.",
    )
    return false
  }

  const loadResult = yield* Effect.try({
    try: () => vecModule.value.getLoadablePath(),
    catch: () => new Error("Failed to get sqlite-vec loadable path"),
  }).pipe(Effect.option)

  if (loadResult._tag === "None") {
    yield* Effect.logWarning(
      "sqlite-vec native extension not found. Vector search will be unavailable.",
    )
    return false
  }

  return yield* client.loadExtension(loadResult.value).pipe(
    Effect.as(true),
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        yield* Effect.logWarning(
          "sqlite-vec extension could not be loaded. Vector search will be unavailable.",
          error,
        )
        return false
      }),
    ),
  )
})
