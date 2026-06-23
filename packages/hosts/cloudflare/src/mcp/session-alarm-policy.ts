/** Idle timeout for MCP sessions with no paused continuations. */
export const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

/** Lease extension while paused executions block hibernation (matches browser approval wait). */
export const PAUSED_EXECUTION_LEASE_MS = 10 * 60 * 1000;

export type SessionAlarmDecision =
  | { readonly kind: "idle_within_timeout" }
  | { readonly kind: "destroy_idle_session" }
  | { readonly kind: "extend_paused_lease"; readonly leaseMs: number };

export const decideSessionAlarm = (input: {
  readonly idleMs: number;
  readonly pausedExecutionCount: number;
}): SessionAlarmDecision => {
  if (input.idleMs < SESSION_TIMEOUT_MS) {
    return { kind: "idle_within_timeout" };
  }
  if (input.pausedExecutionCount > 0) {
    return { kind: "extend_paused_lease", leaseMs: PAUSED_EXECUTION_LEASE_MS };
  }
  return { kind: "destroy_idle_session" };
};

export const pausedLeaseExtensionLog = (input: {
  readonly sessionId: string;
  readonly pausedExecutionCount: number;
  readonly idleMs: number;
  readonly leaseMs: number;
}): Record<string, unknown> => ({
  event: "mcp_session_paused_lease_extension",
  sessionId: input.sessionId,
  pausedExecutionCount: input.pausedExecutionCount,
  idleMs: input.idleMs,
  leaseMs: input.leaseMs,
});
