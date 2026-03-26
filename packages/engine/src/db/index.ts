export { EXECUTOR_DB_FILENAME } from "./client"
export {
  syncSourceToSqlite,
  hasSourceCatalogData,
  loadSemanticSearchSignature,
  writeSemanticSearchSignature,
} from "./indexer"
export {
  loadSourceStatus,
  loadSourceLifecycle,
  upsertSourceStatus,
  removeSource,
  syncSourceLifecycle,
  type SourceStatusRecord,
} from "./source-state"
export { makeWorkspaceCatalogDbLayer, makeWorkspaceCatalogQueryDbLayer } from "./setup"

// Drizzle table schemas used by control-plane services
export { policy } from "./schema/policy.sql"
export { catalog_tool } from "./schema/catalog-tool.sql"
export { catalog_revision } from "./schema/source-catalog.sql"
