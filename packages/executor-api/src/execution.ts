// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type ExecutionStatus =
  | "pending"
  | "running"
  | "waiting_for_interaction"
  | "completed"
  | "failed"
  | "cancelled";

export type InteractionMode = "live" | "live_form" | "detach";

export interface ExecutionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly createdByAccountId: string;
  readonly executionSessionId: string | null;
  readonly status: ExecutionStatus;
  readonly code: string;
  readonly resultJson: string | null;
  readonly errorText: string | null;
  readonly logsJson: string | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ---------------------------------------------------------------------------
// Execution interaction
// ---------------------------------------------------------------------------

export type ExecutionInteractionStatus = "pending" | "resolved" | "cancelled";

export interface ExecutionInteraction {
  readonly id: string;
  readonly executionId: string;
  readonly status: ExecutionInteractionStatus;
  readonly kind: string;
  readonly purpose: string;
  readonly payloadJson: string;
  readonly responseJson: string | null;
  readonly responsePrivateJson: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ---------------------------------------------------------------------------
// Execution envelope (record + pending interaction)
// ---------------------------------------------------------------------------

export interface ExecutionEnvelope {
  readonly execution: ExecutionRecord;
  readonly pendingInteraction: ExecutionInteraction | null;
}

// ---------------------------------------------------------------------------
// Execution step
// ---------------------------------------------------------------------------

export type ExecutionStepKind = "tool_call";
export type ExecutionStepStatus = "pending" | "waiting" | "completed" | "failed";

export interface ExecutionStep {
  readonly id: string;
  readonly executionId: string;
  readonly sequence: number;
  readonly kind: ExecutionStepKind;
  readonly status: ExecutionStepStatus;
  readonly path: string;
  readonly argsJson: string;
  readonly resultJson: string | null;
  readonly errorText: string | null;
  readonly interactionId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ---------------------------------------------------------------------------
// Request / response payloads
// ---------------------------------------------------------------------------

export interface CreateExecutionRequest {
  readonly code: string;
  readonly executionSessionId?: string;
  readonly interactionMode?: InteractionMode;
}

export interface ResumeExecutionRequest {
  readonly responseJson?: string;
  readonly interactionMode?: InteractionMode;
}
