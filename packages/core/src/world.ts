import type { Layer } from "effect/Layer";
import type { SqlClient } from "@effect/sql/SqlClient";

import type { VectorSearchShape } from "./ports/vector-search";
import type { EmbedderShape } from "./ports/embedder";

/**
 * An ExecutorWorld provides the platform-specific infrastructure that the
 * executor core needs. Worlds are thin — they provide connections, not logic.
 *
 * Core owns all schema, queries, and business logic. Worlds just provide:
 * 1. A SQL database connection (required)
 * 2. A vector search backend (optional — sqlite-vec locally, Vectorize on CF)
 * 3. An embedding generator (optional — local model or Workers AI)
 */
export interface ExecutorWorld {
  /** SQL database connection — core owns all schema and queries */
  readonly database: Layer<SqlClient, any, any>;

  /** Vector similarity search — sqlite-vec locally, Vectorize on Cloudflare */
  readonly vectorSearch?: Layer<VectorSearchShape, any, any>;

  /** Embedding generation — local model, API call, or Workers AI */
  readonly embedder?: Layer<EmbedderShape, any, any>;
}
