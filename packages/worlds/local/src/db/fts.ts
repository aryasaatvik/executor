import { SqlClient } from "@effect/sql"
import * as Effect from "effect/Effect"

/**
 * Set up the FTS5 virtual table and sync triggers for catalog_tool.
 *
 * FTS5 virtual tables and triggers cannot be expressed in Drizzle's
 * schema DSL, so we run raw SQL to create them.
 *
 * This is idempotent — all statements use IF NOT EXISTS.
 */
export const setupCatalogToolFts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // FTS5 virtual table for full-text search over tool metadata
  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS catalog_tool_fts USING fts5(
      path, title, description, search_text,
      content=catalog_tool, content_rowid=rowid,
      tokenize='porter unicode61'
    )
  `

  // Trigger: sync FTS on INSERT
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS catalog_tool_fts_ai AFTER INSERT ON catalog_tool BEGIN
      INSERT INTO catalog_tool_fts(rowid, path, title, description, search_text)
      VALUES (new.rowid, new.path, new.title, new.description, new.search_text);
    END
  `

  // Trigger: sync FTS on DELETE
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS catalog_tool_fts_ad AFTER DELETE ON catalog_tool BEGIN
      INSERT INTO catalog_tool_fts(catalog_tool_fts, rowid, path, title, description, search_text)
      VALUES ('delete', old.rowid, old.path, old.title, old.description, old.search_text);
    END
  `

  // Trigger: sync FTS on UPDATE (delete old, insert new)
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS catalog_tool_fts_au AFTER UPDATE ON catalog_tool BEGIN
      INSERT INTO catalog_tool_fts(catalog_tool_fts, rowid, path, title, description, search_text)
      VALUES ('delete', old.rowid, old.path, old.title, old.description, old.search_text);
      INSERT INTO catalog_tool_fts(rowid, path, title, description, search_text)
      VALUES (new.rowid, new.path, new.title, new.description, new.search_text);
    END
  `
})
