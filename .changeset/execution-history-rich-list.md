---
"@executor-js/plugin-execution-history": minor
---

Rework the runs list into a keyset-paginated, aggregate-aware read surface
backed by the storage JSON pushdown. The `list` endpoint now takes an opaque
keyset `cursor` (instead of offset), a sort field (`startedAt`/`durationMs`)
with direction, and a live-tail `after` floor, and returns `{ runs, nextCursor,
meta }`. The `meta` block — computed once per filter set on the first page —
carries status/trigger facet counts (each ignoring its own filter), interaction
counts, a stacked-by-status timeline with a server-chosen bucket width, total
and filtered row counts, and duration min/max plus P50–P99 percentiles. All
counts, buckets, percentiles, and pages are pushed to SQL rather than reducing
the whole collection in memory. Tool-path facets and full-text code search are
intentionally not included yet.
