---
"@executor-js/plugin-execution-history": minor
---

Rebuild the runs page as an openstatus-style observability table on the keyset +
aggregate API. The page now has a faceted filter rail (status / trigger /
interaction / time range with live counts), a cmdk filter command palette, a
stacked-by-status timeline chart with drag-to-zoom, live tailing, keyset
infinite scroll, sortable columns, column visibility, keyboard shortcuts, and
the existing 4-tab detail drawer. List data flows through an Effect-atoms hook
(`useRunsList`) that accumulates cursor pages and polls the head for live mode;
the accumulation logic is a pure, unit-tested reducer. Adds `recharts` as an
optional peer dependency (provided by `@executor-js/react`).
