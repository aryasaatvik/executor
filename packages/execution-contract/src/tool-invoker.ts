import type * as Effect from "effect/Effect"

/**
 * Context passed alongside a tool invocation.
 */
export type InvocationContext = {
  readonly runId?: string
  readonly executionSessionId?: string
  readonly callId?: string
  readonly scope?: string
  readonly actor?: string
  readonly [key: string]: unknown
}

/**
 * Input for a single tool invocation.
 */
export type ToolInvocationInput = {
  readonly path: string
  readonly args: unknown
  readonly context?: InvocationContext
}

/**
 * Invokes a tool by path with arguments and optional context.
 * This is the boundary between the sandbox runtime and the host.
 */
export interface ToolInvoker {
  invoke(input: ToolInvocationInput): Effect.Effect<unknown, unknown>
}
