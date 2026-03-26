import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

import type { SourceId } from "@executor/control-plane/model"

import { Timestamps } from "../schema.sql"
import { source } from "./source.sql"

export const catalog_tool = sqliteTable("catalog_tool", {
  toolId:            text("tool_id").primaryKey(),
  path:              text().notNull(),
  sourceId:          text("source_id").$type<SourceId>().notNull().references(() => source.id, { onDelete: "cascade" }),
  sourceKey:         text("source_key").notNull(),
  namespace:         text().notNull(),
  title:             text(),
  description:       text(),
  searchText:        text("search_text").notNull(),
  inputSchemaJson:   text("input_schema_json", { mode: "json" }),
  outputSchemaJson:  text("output_schema_json", { mode: "json" }),
  inputTypePreview:  text("input_type_preview"),
  outputTypePreview: text("output_type_preview"),
  interaction:       text().default("auto"),
  providerKind:      text("provider_kind"),
  contentHash:       text("content_hash").notNull(),
  sourceEnabled:     integer("source_enabled", { mode: "boolean" }).notNull().default(true),
  sourceStatus:      text("source_status").default("connected"),
  capabilityJson:    text("capability_json"),
  executableJson:    text("executable_json"),
  ...Timestamps,
}, (table) => [
  index("idx_tool_source").on(table.sourceId),
  index("idx_tool_namespace").on(table.namespace),
  index("idx_tool_path").on(table.path),
])
