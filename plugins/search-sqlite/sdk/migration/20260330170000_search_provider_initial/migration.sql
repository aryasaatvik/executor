CREATE TABLE IF NOT EXISTS search_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  source_hash TEXT,
  generated_at INTEGER NOT NULL,
  path TEXT NOT NULL,
  namespace TEXT NOT NULL,
  search_text TEXT NOT NULL,
  title TEXT,
  description TEXT,
  interaction TEXT NOT NULL,
  protocol TEXT,
  method TEXT,
  path_template TEXT,
  raw_tool_id TEXT,
  operation_id TEXT,
  tool_group TEXT,
  leaf TEXT,
  tags_json TEXT NOT NULL,
  input_type_preview TEXT,
  output_type_preview TEXT,
  contract_json TEXT,
  metadata_json TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS search_documents_source_path_unique
  ON search_documents (source_id, path);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS search_documents_source_id_index
  ON search_documents (source_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS search_documents_namespace_index
  ON search_documents (namespace);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS search_sources (
  source_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  source_hash TEXT,
  generated_at INTEGER NOT NULL,
  document_count INTEGER NOT NULL,
  vector_document_count INTEGER,
  vector_error TEXT,
  vector_backend TEXT,
  embedder_key TEXT,
  embedded_at INTEGER,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS search_documents_fts USING fts5(
  path,
  namespace,
  search_text,
  title,
  description,
  protocol,
  method,
  path_template,
  raw_tool_id,
  operation_id,
  tool_group,
  leaf,
  tags,
  content='search_documents',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3 4 5'
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS search_documents_ai
AFTER INSERT ON search_documents
BEGIN
  INSERT INTO search_documents_fts(
    rowid,
    path,
    namespace,
    search_text,
    title,
    description,
    protocol,
    method,
    path_template,
    raw_tool_id,
    operation_id,
    tool_group,
    leaf,
    tags
  ) VALUES (
    new.id,
    new.path,
    new.namespace,
    new.search_text,
    new.title,
    new.description,
    new.protocol,
    new.method,
    new.path_template,
    new.raw_tool_id,
    new.operation_id,
    new.tool_group,
    new.leaf,
    new.tags_json
  );
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS search_documents_ad
AFTER DELETE ON search_documents
BEGIN
  INSERT INTO search_documents_fts(
    search_documents_fts,
    rowid,
    path,
    namespace,
    search_text,
    title,
    description,
    protocol,
    method,
    path_template,
    raw_tool_id,
    operation_id,
    tool_group,
    leaf,
    tags
  ) VALUES (
    'delete',
    old.id,
    old.path,
    old.namespace,
    old.search_text,
    old.title,
    old.description,
    old.protocol,
    old.method,
    old.path_template,
    old.raw_tool_id,
    old.operation_id,
    old.tool_group,
    old.leaf,
    old.tags_json
  );
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS search_documents_au
AFTER UPDATE ON search_documents
BEGIN
  INSERT INTO search_documents_fts(
    search_documents_fts,
    rowid,
    path,
    namespace,
    search_text,
    title,
    description,
    protocol,
    method,
    path_template,
    raw_tool_id,
    operation_id,
    tool_group,
    leaf,
    tags
  ) VALUES (
    'delete',
    old.id,
    old.path,
    old.namespace,
    old.search_text,
    old.title,
    old.description,
    old.protocol,
    old.method,
    old.path_template,
    old.raw_tool_id,
    old.operation_id,
    old.tool_group,
    old.leaf,
    old.tags_json
  );
  INSERT INTO search_documents_fts(
    rowid,
    path,
    namespace,
    search_text,
    title,
    description,
    protocol,
    method,
    path_template,
    raw_tool_id,
    operation_id,
    tool_group,
    leaf,
    tags
  ) VALUES (
    new.id,
    new.path,
    new.namespace,
    new.search_text,
    new.title,
    new.description,
    new.protocol,
    new.method,
    new.path_template,
    new.raw_tool_id,
    new.operation_id,
    new.tool_group,
    new.leaf,
    new.tags_json
  );
END;
