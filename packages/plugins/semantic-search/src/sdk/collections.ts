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
