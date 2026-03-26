// ---------------------------------------------------------------------------
// Executor identity & discovery
// ---------------------------------------------------------------------------

export interface ExecutorCapabilities {
  readonly runtimes: readonly string[];
  readonly maxConcurrentExecutions: number;
  readonly supportsMcp: boolean;
  readonly supportsOAuth: boolean;
}

export interface ExecutorDescriptor {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly capabilities: ExecutorCapabilities;
}

export type ExecutorTarget =
  | { readonly kind: "remote"; readonly id: string; readonly baseUrl: string; readonly managed: true }
  | { readonly kind: "local"; readonly origin: string; readonly discoveredAt: number; readonly managed: false };

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface HealthResponse {
  readonly status: "ok" | "degraded";
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export interface ApiError {
  readonly code: "bad_request" | "unauthorized" | "forbidden" | "not_found" | "storage";
  readonly message: string;
}
