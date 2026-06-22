import { ToolSchemaManifest } from "@executor-js/sdk/core";
import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Per-run tool-manifest snapshot.
//
// The scan phase used to re-read the entire `tool_schema_manifest` table from D1
// on every page (12 partitions × ~N/limit pages), so an unchanged catalog cost
// O(N²/pageLimit) cross-region reads. Instead, `create` reads the manifest once,
// partitions it, and writes one snapshot per partition to the executor's KV cache.
// `scan` then reads only its partition's snapshot — KV-only, no D1 fallback on the
// hot path; a miss fails the message so the queue retries (the initial scan fan-out
// is delayed once to let the write propagate). Snapshots are deleted when the run
// reaches a terminal state (`complete` or terminal `fail`).
//
// Only `create` writes the snapshot — `reconcile` (resume) does not. The snapshot is
// durable (no TTL; removed only at terminal state), so a resumed stalled run still
// finds it. If a snapshot is ever genuinely absent at resume (e.g. a version-key bump
// or KV rollback), its scans DLQ and the recovery path is a fresh reindex, not resume.
// ---------------------------------------------------------------------------

export const MANIFEST_SNAPSHOT_PREFIX = "index-manifest/";
export const MANIFEST_SNAPSHOT_VERSION = "v1";

/** A manifest paired with its ordinal in the full (pre-partition) manifest list.
 *  The ordinal is preserved so partitioned jobs keep the same stable ordering
 *  they had when the scan filtered the full list in-process. */
const ManifestSnapshotItem = Schema.Struct({
  ordinal: Schema.Number,
  manifest: ToolSchemaManifest,
});
export type ManifestSnapshotItem = typeof ManifestSnapshotItem.Type;

/** One partition's slice of the run's manifest snapshot. Sharded per partition so
 *  a scan message loads only its ~N/partitions rows, not the whole catalog, and
 *  no single KV value approaches the 25 MB cap. */
export const ManifestSnapshotEntry = Schema.Struct({
  version: Schema.Literal(MANIFEST_SNAPSHOT_VERSION),
  items: Schema.Array(ManifestSnapshotItem),
});
export type ManifestSnapshotEntry = typeof ManifestSnapshotEntry.Type;

export const manifestSnapshotKey = (runId: string, partition: number): string =>
  `${MANIFEST_SNAPSHOT_PREFIX}${MANIFEST_SNAPSHOT_VERSION}/${runId}/${partition}`;
