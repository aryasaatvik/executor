import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";

// ---------------------------------------------------------------------------
// Local execution engine — QuickJS in-process code substrate.
//
// Unlike the Cloudflare host (per-execution Worker isolates via the LOADER
// binding) or cloud (Dynamic Workers), the local single-user daemon runs code
// in-process in a QuickJS sandbox. No external isolate service, no network hop:
// `makeQuickJsExecutor()` builds the WASM-backed QuickJS runtime that
// `createExecutionEngine` drives, and tool calls resolve directly against the
// one boot executor.
//
// This is the only execution-stack seam local needs. Local serves its ONE
// cwd-scoped executor directly (the `FixedExecutionProvider` seam in app.ts),
// so there is no DbProvider / PluginsProvider / HostConfig / CodeExecutorProvider
// per-request rebuild — the code executor is constructed here and handed to
// `createExecutionEngine` at boot in app.ts / main.ts.
// ---------------------------------------------------------------------------

/**
 * Build the QuickJS in-process code executor the local engine runs on. Called
 * once per boot (the API handler and the in-process MCP handler each build their
 * own engine over the SAME boot executor, so each gets its own code-executor
 * instance). Swap this for a different `@executor-js/runtime-*` factory to change
 * the local execution substrate.
 */
export const makeLocalCodeExecutor = () => makeQuickJsExecutor();
