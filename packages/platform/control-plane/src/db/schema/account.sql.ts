import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../schema.sql"

export const account = sqliteTable("account", {
  id:           text().primaryKey(),
  provider:     text().notNull(),
  subject:      text().notNull(),
  email:        text(),
  display_name: text(),
  ...Timestamps,
})
