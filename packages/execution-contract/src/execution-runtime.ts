import type * as Effect from "effect/Effect"
import type * as Stream from "effect/Stream"
import type { ExecutionEvent } from "./execution-event"
import type { RuntimeKind } from "./runtime-kind"
import type { ToolInvoker } from "./tool-invoker"

/**
 * Isolation level the runtime enforces.
 */
export type IsolationLevel = "process" | "vm" | "compartment" | "worker"

/**
 * Declares what the runtime needs from the host.
 */
export type RuntimeRequirements = {
  readonly isolation: IsolationLevel
  readonly networkAccess: boolean
  readonly fileSystemAccess: boolean
}

/**
 * Input for preparing an execution session.
 */
export type PrepareInput = {
  readonly code: string
  readonly toolInvoker: ToolInvoker
  readonly memoryLimitMb?: number
  readonly timeoutMs?: number
}

/**
 * A prepared session ready to be started.
 */
export type PreparedSession = {
  readonly id: string
  readonly runtimeKind: RuntimeKind
}

/**
 * Handle to a running execution, used to stop it.
 */
export type RuntimeHandle = {
  readonly sessionId: string
  readonly runtimeKind: RuntimeKind
}

/**
 * Contract that all sandbox runtimes implement.
 *
 * Enriches the original CodeExecutor with lifecycle (prepare/start/stop)
 * and streaming execution events.
 */
export interface ExecutionRuntime {
  readonly kind: RuntimeKind
  readonly requirements: RuntimeRequirements

  /**
   * Prepare an execution session (compile code, allocate sandbox resources).
   */
  prepare(input: PrepareInput): Effect.Effect<PreparedSession, unknown>

  /**
   * Start the prepared session and stream execution events.
   */
  start(session: PreparedSession): Stream.Stream<ExecutionEvent, unknown>

  /**
   * Stop a running execution and release resources.
   */
  stop(handle: RuntimeHandle): Effect.Effect<void, unknown>
}
