import { sqliteTable, text } from "drizzle-orm/sqlite-core"

import type { AccountId } from "#schema";

import { Timestamps } from "../schema.sql"

export const account = sqliteTable("account", {
  id:          text().$type<AccountId>().primaryKey(),
  provider:    text().notNull(),
  subject:     text().notNull(),
  email:       text(),
  displayName: text("display_name"),
  ...Timestamps,
})
