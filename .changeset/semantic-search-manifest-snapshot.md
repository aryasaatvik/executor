---
"@executor-js/sdk": minor
"@executor-js/plugin-semantic-search": minor
---

Snapshot the tool manifest per reindex run instead of re-reading it from D1 on every scan page.

`createExecutor` now exposes its cache `KeyValueStore` on the executor instance as `executor.cache`, so plugins can reach durable cache storage (Cloudflare KV in production) without re-threading a binding — wrap it with `KeyValueStore.toSchemaStore` for typed entries, the same way the internal `tools.list` / schema-view caches do.

The semantic-search scan phase used to call `tools.manifest()` — a full `tool_schema_manifest` table read — once per partition page, so an unchanged catalog cost `O(N² / pageLimit)` cross-region reads. Now `create` reads the manifest once, partitions it, and writes one snapshot per partition to `executor.cache`; `scan` reads only its partition's snapshot (KV-only, with no D1 fallback on the hot path — a miss fails the message so the queue retries). Snapshots are deleted when the run completes. This collapses the scan's manifest reads from `O(N² / pageLimit)` to a single pass and cuts per-message memory from the whole manifest to one partition's slice.
