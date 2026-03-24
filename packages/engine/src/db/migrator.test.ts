import { SqlClient } from "@effect/sql"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import { applyDrizzleMigrations } from "./migrator"

describe("applyDrizzleMigrations", () => {
  it.effect("includes the execution_session_id migration for the execution table", () =>
    Effect.gen(function* () {
      const executedStatements: string[] = []

      const sql = Object.assign(
        (_strings: TemplateStringsArray, ..._values: ReadonlyArray<unknown>) =>
          Effect.void,
        {
          unsafe: (statement: string, _params?: ReadonlyArray<unknown>) => {
            executedStatements.push(statement)

            if (statement.startsWith("SELECT id, hash, created_at, name FROM")) {
              return Effect.succeed([])
            }

            return Effect.succeed([])
          },
          withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
        },
      )

      yield* applyDrizzleMigrations.pipe(
        Effect.provide(Layer.succeed(SqlClient.SqlClient, sql as never)),
      )

      expect(
        executedStatements.some((statement) =>
          statement.includes(
            "ALTER TABLE `execution` ADD COLUMN `execution_session_id` text;",
          ),
        ),
      ).toBe(true)
    }),
  )
})
