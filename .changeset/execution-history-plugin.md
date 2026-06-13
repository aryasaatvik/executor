---
"@executor-js/plugin-execution-history": minor
---

Add the `@executor-js/plugin-execution-history` plugin — an opt-in execution
history sink built on the ExecutionObserver foundation. It records every run
(plus its tool calls and interactions) into three owner-scoped pluginStorage
collections via a buffered-batch writer (no new tables, no migrations; works on
D1/libSQL/sqlite/postgres), exposes a `list`/`get`/`listToolCalls` read API over
HttpApi (`./api`'s `executionHistoryHttpPlugin`), and ships a Runs page UI
(`./client`) that mounts at `/plugins/executionHistory/`. The base `.` entry is
SDK-only and never loads `@executor-js/api` or React.
