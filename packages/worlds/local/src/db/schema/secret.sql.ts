import { sqliteTable, text } from "drizzle-orm/sqlite-core"

import type { SecretMaterialId, SecretMaterialPurpose } from "@executor/control-plane/model"

import { Timestamps } from "../schema.sql"

export const secret_material = sqliteTable("secret_material", {
  id:         text().$type<SecretMaterialId>().primaryKey(),
  name:       text(),
  purpose:    text().$type<SecretMaterialPurpose>().notNull(),
  providerId: text("provider_id").notNull(),
  handle:     text().notNull(),
  value:      text(),
  ...Timestamps,
})
