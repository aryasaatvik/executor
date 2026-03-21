import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../schema.sql"

export const secret_material = sqliteTable("secret_material", {
  id:           text().primaryKey(),
  name:         text(),
  purpose:      text().notNull(),
  provider_id:  text().notNull(),
  handle:       text().notNull(),
  value:        text(),
  ...Timestamps,
})
