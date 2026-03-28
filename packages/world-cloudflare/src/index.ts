import type { ExecutorWorld } from "@executor/core/world";

// ---------------------------------------------------------------------------
// Cloudflare environment bindings
// ---------------------------------------------------------------------------

export interface CloudflareEnv {
  readonly DB: unknown;         // D1Database binding
  readonly VECTORIZE: unknown;  // VectorizeIndex binding
  readonly AI: unknown;         // Workers AI binding
}

// ---------------------------------------------------------------------------
// Cloudflare world factory
//
// Provides D1 for SQL, Vectorize for vector search, Workers AI for embeddings.
// Core owns all schema and queries — this just provides the connections.
// ---------------------------------------------------------------------------

export const createCloudflareWorld = (_env: CloudflareEnv): ExecutorWorld => ({
  database: {} as any,  // TODO: D1Client.layer({ db: env.DB })
  // vectorSearch: TODO: VectorizeSearch.layer({ index: env.VECTORIZE }),
  // embedder: TODO: WorkersAIEmbedder.layer({ ai: env.AI }),
});
