import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core"

import type { WorkspaceId } from "@executor/control-plane/model"

export const workspace_state = sqliteTable("workspace_state", {
  workspaceId: text("workspace_id").$type<WorkspaceId>().notNull(),
  key:         text().notNull(),
  value:       text(),
  updatedAt:   integer("updated_at").notNull().$onUpdate(() => Date.now()),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.key] }),
])
