---
"@executor-js/plugin-execution-metrics": minor
---

Add the `@executor-js/plugin-execution-metrics` plugin — an opt-in metrics sink
built on the ExecutionObserver foundation. The base plugin drives Effect Metric
counters and an execution-duration histogram from the event stream; `./api`'s
`executionMetricsHttpPlugin` exposes them as an auth-gated `GET
/execution-metrics/metrics` Prometheus scrape for long-lived hosts; and
`./cloudflare`'s `createWaeMetricsObserver` writes Workers Analytics Engine data
points on the Cloudflare host (per-isolate Effect metrics being meaningless on a
Worker fleet). The base `.` entry never loads `@executor-js/api` or
`@cloudflare/workers-types`.
