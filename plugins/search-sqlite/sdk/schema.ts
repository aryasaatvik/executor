import type {
  InferInsertModel,
  InferSelectModel,
} from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const SEARCH_DOCUMENTS_TABLE = "search_documents";
export const SEARCH_FTS_TABLE = "search_documents_fts";
export const SEARCH_SOURCES_TABLE = "search_sources";
export const SEARCH_VECTORS_TABLE = "search_documents_vec";

export const searchDocuments = sqliteTable(
  SEARCH_DOCUMENTS_TABLE,
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source_id: text("source_id").notNull(),
    source_kind: text("source_kind").notNull(),
    provider_key: text("provider_key").notNull(),
    revision_id: text("revision_id").notNull(),
    source_hash: text("source_hash"),
    generated_at: integer("generated_at").notNull(),
    path: text("path").notNull(),
    namespace: text("namespace").notNull(),
    search_text: text("search_text").notNull(),
    title: text("title"),
    description: text("description"),
    interaction: text("interaction").$type<"auto" | "required">().notNull(),
    protocol: text("protocol"),
    method: text("method"),
    path_template: text("path_template"),
    raw_tool_id: text("raw_tool_id"),
    operation_id: text("operation_id"),
    tool_group: text("tool_group"),
    leaf: text("leaf"),
    tags_json: text("tags_json").notNull(),
    input_type_preview: text("input_type_preview"),
    output_type_preview: text("output_type_preview"),
    contract_json: text("contract_json"),
    metadata_json: text("metadata_json").notNull(),
  },
  (table) => ({
    source_path_unique: uniqueIndex("search_documents_source_path_unique").on(
      table.source_id,
      table.path,
    ),
    source_id_index: index("search_documents_source_id_index").on(table.source_id),
    namespace_index: index("search_documents_namespace_index").on(table.namespace),
  }),
);

export const searchSources = sqliteTable(
  SEARCH_SOURCES_TABLE,
  {
    source_id: text("source_id").primaryKey(),
    source_kind: text("source_kind").notNull(),
    provider_key: text("provider_key").notNull(),
    revision_id: text("revision_id").notNull(),
    source_hash: text("source_hash"),
    generated_at: integer("generated_at").notNull(),
    document_count: integer("document_count").notNull(),
    vector_document_count: integer("vector_document_count"),
    vector_error: text("vector_error"),
    vector_backend: text("vector_backend"),
    embedder_key: text("embedder_key"),
    embedded_at: integer("embedded_at"),
    updated_at: integer("updated_at").notNull(),
  },
);

export type SearchDocumentRow = InferSelectModel<typeof searchDocuments>;
export type InsertSearchDocumentRow = InferInsertModel<typeof searchDocuments>;
export type SearchSourceStateRow = InferSelectModel<typeof searchSources>;
export type InsertSearchSourceStateRow = InferInsertModel<typeof searchSources>;
