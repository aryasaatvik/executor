---
"@executor-js/plugin-execution-history": patch
---

Rebuild the runs list as a real semantic `<table>` with content-fit columns.
Each column now sizes to the maximum width its rows need (browser
`table-layout: auto`), instead of fixed pixel widths — the sticky `<thead>` and
the rows share one column model so they stay aligned for free. Short / numeric /
badge columns (status, duration, tools, interaction, log) are centered; text
columns (started, trigger, actor, code) are left-aligned. The two columns that
can run long — `actor` and `code` — are width-capped and truncated (hover shows
the full value). Removes the fixed-width `COL_*` slot constants and the
`min-w` horizontal-scroll floor.
