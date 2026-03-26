/**
 * Emitted when the runtime produces a log line.
 */
export type LogEvent = {
  readonly _tag: "LogEvent"
  readonly level: "debug" | "info" | "warn" | "error"
  readonly message: string
  readonly timestamp: number
}

/**
 * Emitted when agent code invokes a tool.
 */
export type ToolCallEvent = {
  readonly _tag: "ToolCallEvent"
  readonly path: string
  readonly args: unknown
  readonly callId: string
  readonly timestamp: number
}

/**
 * Emitted when a tool call completes.
 */
export type ToolResultEvent = {
  readonly _tag: "ToolResultEvent"
  readonly callId: string
  readonly result: unknown
  readonly error?: string
  readonly timestamp: number
}

/**
 * Emitted when the execution produces a final result.
 */
export type ResultEvent = {
  readonly _tag: "ResultEvent"
  readonly result: unknown
  readonly logs?: readonly string[]
  readonly timestamp: number
}

/**
 * Emitted when the execution encounters an unrecoverable error.
 */
export type ErrorEvent = {
  readonly _tag: "ErrorEvent"
  readonly error: string
  readonly timestamp: number
}

/**
 * Union of all events a runtime can emit during execution.
 */
export type ExecutionEvent =
  | LogEvent
  | ToolCallEvent
  | ToolResultEvent
  | ResultEvent
  | ErrorEvent
