import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../schema.sql"
import { source } from "./source.sql"

export const catalog_tool = sqliteTable("catalog_tool", {
  tool_id:              text().primaryKey(),
  path:                 text().notNull(),
  source_id:            text().notNull().references(() => source.id, { onDelete: "cascade" }),
  source_key:           text().notNull(),
  namespace:            text().notNull(),
  title:                text(),
  description:          text(),
  search_text:          text().notNull(),
  input_schema_json:    text({ mode: "json" }),
  output_schema_json:   text({ mode: "json" }),
  input_type_preview:   text(),
  output_type_preview:  text(),
  interaction:          text().default("auto"),
  provider_kind:        text(),
  content_hash:         text().notNull(),
  source_enabled:       integer({ mode: "boolean" }).notNull().default(true),
  source_status:        text().default("connected"),
  ...Timestamps,
}, (table) => [
  index("idx_tool_source").on(table.source_id),
  index("idx_tool_namespace").on(table.namespace),
  index("idx_tool_path").on(table.path),
])
