---
"@executor-js/plugin-execution-history": minor
---

Move per-run detail to an append-only R2 object and slim the D1 index. The
`runs` row now keeps only list/aggregate fields plus a bounded `codePreview` and
denormalized `logErrorCount`/`logWarnCount`, so the runs list renders entirely
from D1 with no per-row blob fetch. Full `code`, `resultJson`, `errorText`,
`logsJson`, `triggerMetaJson`, and the per-tool-call / per-interaction rows now
live in one immutable object per run in the plugin blob store (keyed
`run-detail/<executionId>`) — a code-only stub on `ExecutionStarted`, the full
detail on finish. The detail drawer reads it in a single request (`get`
flat-merges the R2 detail onto the slim run); the separate tool-calls endpoint
and `runToolCallsAtom` are removed, and the `toolCalls`/`interactions`
collections are gone.

Breaking: the runs list/detail response shapes change and past runs are cleared
(no backfill, no compatibility shim — the cutover wipe is authoritative).
