import { SqlClient } from "@effect/sql"
import { readMigrationFiles } from "drizzle-orm/migrator"
import * as Effect from "effect/Effect"
import { fileURLToPath } from "node:url"

const DRIZZLE_MIGRATIONS_TABLE = "__drizzle_migrations"
const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("./migrations", import.meta.url),
)

type DbMigrationRow = {
  id: number
  hash: string
  created_at: string | number | null
  name: string | null
}

const getPendingMigrations = (
  localMigrations: ReturnType<typeof readMigrationFiles>,
  dbMigrations: ReadonlyArray<DbMigrationRow>,
) => {
  const appliedNames = new Set(
    dbMigrations
      .map((migration) => migration.name)
      .filter((name): name is string => name !== null),
  )

  return localMigrations.filter(
    (migration) => !migration.name || !appliedNames.has(migration.name),
  )
}

const hasExecutableSql = (statement: string) =>
  statement.replace(/^[ \t]*--.*$/gm, "").trim().length > 0

export const applyDrizzleMigrations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const localMigrations = yield* Effect.sync(() =>
    readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER }),
  )

  yield* sql.unsafe(
    `CREATE TABLE IF NOT EXISTS ${DRIZZLE_MIGRATIONS_TABLE} (
      id INTEGER PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric,
      name text,
      applied_at TEXT
    )`,
  )

  const dbMigrations = yield* sql.unsafe<DbMigrationRow>(
    `SELECT id, hash, created_at, name FROM ${DRIZZLE_MIGRATIONS_TABLE}`,
  )

  const pendingMigrations = getPendingMigrations(localMigrations, dbMigrations)
  if (pendingMigrations.length === 0) {
    return
  }

  yield* sql.withTransaction(
    Effect.forEach(
      pendingMigrations,
      (migration) =>
        Effect.gen(function* () {
          for (const statement of migration.sql) {
            if (!hasExecutableSql(statement)) {
              continue
            }

            yield* sql.unsafe(statement)
          }

          yield* sql.unsafe(
            `INSERT INTO ${DRIZZLE_MIGRATIONS_TABLE} (hash, created_at, name, applied_at)
             VALUES (?, ?, ?, ?)`,
            [
              migration.hash,
              migration.folderMillis,
              migration.name ?? null,
              new Date().toISOString(),
            ],
          )
        }),
      { discard: true },
    ),
  )
})
