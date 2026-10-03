---
"@executor-js/codemode-core": minor
"@executor-js/execution": minor
"@executor-js/runtime-dynamic-worker": patch
"@executor-js/api": minor
---

Include ordered tool-call audits on completed HTTP executions and resumes, with each invocation's path, error outcome, and elapsed duration. Replace execution tool-path tracking with these records while preserving connected-tool identity in MCP results.

Wait for started invocations to settle before returning the audit, interrupt outstanding calls when the script fails, and measure durations monotonically.

Dynamic Workers drain sandbox-launched tool promises after normal completion, so asynchronous encoding and RPC cannot register an invocation after its audit is collected. Their existing watchdog suspends during host dispatch and approval waits; thrown script errors return immediately.
