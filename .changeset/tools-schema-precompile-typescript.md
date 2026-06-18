---
"@executor-js/sdk": minor
"@executor-js/plugin-semantic-search": patch
---

Always render the TypeScript preview in `executor.tools.schema` and warm it during
indexing. The `includeTypeScript` option (and the now-empty `ToolSchemaOptions` type) is
removed — the only caller that passed `false` was the reindex pipeline, which did so to
skip the CPU-heavy JSON-schema → TypeScript codegen. It now calls `tools.schema` plainly,
so every reindex pre-warms exactly the schema view the web UI reads on first open (the
codegen is content-addressed in KV), turning first tool-detail views into cache hits
instead of a cold compile. The embedding text is unchanged — the indexer only ever read
the raw schema facets, never the rendered TypeScript. Because `includeTypeScript` is
dropped from the schema-view cache key, existing cached entries are superseded on the next
reindex or view (regenerable derived data).
