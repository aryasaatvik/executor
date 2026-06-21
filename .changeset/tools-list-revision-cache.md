---
"@executor-js/sdk": minor
---

Cache `tools.list` by a content-derived catalog revision. `produceConnectionTools` now
records a per-connection `toolset_revision` — a hash of the connection's manifest
`(path, index_fingerprint)` pairs — in `plugin_storage`, and `tools.list` keys a KV cache of
the DB-derived, policy-filtered list on the combined catalog revision plus a policy
revision (both read live, O(connections)/O(policies), not the full `tool` scan). Static tools
are unioned live and the `query` substring filter is applied post-cache, so a distinct query
reuses the same cached set. The cache stays warm through token rotation and unrelated writes
and invalidates exactly when a connection's tool set, a tool's schema, or a `tool_policy`
changes — including OpenAPI/MCP tool additions on refresh (a new manifest row) and
connection/integration removal.
