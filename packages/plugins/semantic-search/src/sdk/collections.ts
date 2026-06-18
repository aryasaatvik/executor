import { Schema } from "effect";

import { definePluginStorageCollection } from "@executor-js/sdk/core";

// ---------------------------------------------------------------------------
// Vectorize-search plugin storage collections.
//
// `toolFingerprints` stores one row per indexed tool, keyed by `path`, to
// support incremental reindex: on each reindex pass the stored fingerprint is
// compared against the freshly computed one; only changed or new tools are
// re-embedded and upserted. Removed tools are skipped in v1 (logged only).
// ---------------------------------------------------------------------------

export const FingerprintRow = Schema.Struct({
  /** Canonical tool path (e.g. `github.repos.get`). Row key for the diff. */
  path: Schema.String,
  /** Integration slug (e.g. `github`). Carried for namespace-filter queries. */
  integration: Schema.String,
  /** cyrb53-based content hash over path+name+description+inputTS+outputTS. */
  fingerprint: Schema.String,
  /** Vectorize vector ids produced by the chunker for this tool's last embed.
   *  Stored so the reindex can issue a targeted deleteByIds before re-upserting. */
  chunkIds: Schema.Array(Schema.String),
});
export type FingerprintRow = typeof FingerprintRow.Type;

export const toolFingerprints = definePluginStorageCollection("toolFingerprints", FingerprintRow, {
  indexes: ["path"],
});

export const StagedIndexRunStatus = Schema.Literals(["running", "completed", "failed"]);
export type StagedIndexRunStatus = typeof StagedIndexRunStatus.Type;

export const StagedIndexRun = Schema.Struct({
  runId: Schema.String,
  namespace: Schema.String,
  status: StagedIndexRunStatus,
  partitionCount: Schema.Number,
  total: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  error: Schema.optional(Schema.String),
});
export type StagedIndexRun = typeof StagedIndexRun.Type;

export const stagedIndexRuns = definePluginStorageCollection("stagedIndexRuns", StagedIndexRun, {
  indexes: ["runId", "namespace", "status"],
});

export const StagedIndexJobStatus = Schema.Literals([
  "pendingDiff",
  "unchanged",
  "pendingMaterialize",
  "pendingEmbed",
  "committed",
  "failed",
]);
export type StagedIndexJobStatus = typeof StagedIndexJobStatus.Type;

export const StagedIndexJob = Schema.Struct({
  runId: Schema.String,
  namespace: Schema.String,
  partition: Schema.Number,
  ordinal: Schema.Number,
  address: Schema.String,
  path: Schema.String,
  name: Schema.String,
  integration: Schema.String,
  description: Schema.String,
  status: StagedIndexJobStatus,
  fingerprint: Schema.optional(Schema.String),
  oldChunkIds: Schema.Array(Schema.String),
  chunkIds: Schema.Array(Schema.String),
  lexicalTextKey: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  error: Schema.optional(Schema.String),
});
export type StagedIndexJob = typeof StagedIndexJob.Type;

export const stagedIndexJobs = definePluginStorageCollection("stagedIndexJobs", StagedIndexJob, {
  indexes: ["runId", "namespace", "partition", "status", "path", "ordinal"],
});

export const StagedIndexChunkStatus = Schema.Literals(["pendingEmbed", "committed", "failed"]);
export type StagedIndexChunkStatus = typeof StagedIndexChunkStatus.Type;

export const StagedIndexChunk = Schema.Struct({
  runId: Schema.String,
  namespace: Schema.String,
  partition: Schema.Number,
  path: Schema.String,
  chunkId: Schema.String,
  facet: Schema.String,
  chunkIndex: Schema.Number,
  embeddingTextKey: Schema.String,
  embeddingTextBytes: Schema.Number,
  embeddingTextTokens: Schema.Number,
  name: Schema.String,
  integration: Schema.String,
  description: Schema.String,
  status: StagedIndexChunkStatus,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  error: Schema.optional(Schema.String),
});
export type StagedIndexChunk = typeof StagedIndexChunk.Type;

export const stagedIndexChunks = definePluginStorageCollection(
  "stagedIndexChunks",
  StagedIndexChunk,
  {
    indexes: ["runId", "namespace", "partition", "status", "path"],
  },
);
