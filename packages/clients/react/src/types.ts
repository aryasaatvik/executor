// ---------------------------------------------------------------------------
// Loadable — tri-state for async data
// ---------------------------------------------------------------------------

export type Loadable<T> =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "ready"; data: T };

// ---------------------------------------------------------------------------
// Mutation state
// ---------------------------------------------------------------------------

export type MutationResult<TInput, TOutput> = {
  status: "idle" | "pending" | "success" | "error";
  data: TOutput | null;
  error: Error | null;
  mutateAsync: (payload: TInput) => Promise<TOutput>;
  reset: () => void;
};

// ---------------------------------------------------------------------------
// Legacy types not yet in @executor/api — kept as local shims so the web
// app compiles.  These should eventually move to executor-api.
// ---------------------------------------------------------------------------

export interface InstanceConfig {
  readonly semanticSearch: {
    readonly enabled: boolean;
    readonly provider: string | null;
  };
}

export interface SourceInspection {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly sourceKind: string;
  readonly status: string;
  readonly toolCount: number;
  readonly tools: readonly SourceInspectionToolSummary[];
  readonly authInfo: unknown;
}

export interface SourceInspectionToolSummary {
  readonly path: string;
  readonly description: string | null;
}

export interface SourceInspectionToolDetail {
  readonly path: string;
  readonly description: string | null;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
}

export interface SourceInspectionDiscoverResult {
  readonly query: string;
  readonly queryTokens: readonly string[];
  readonly bestPath: string | null;
  readonly total: number;
  readonly results: readonly SourceInspectionDiscoverHit[];
}

export interface SourceInspectionDiscoverHit {
  readonly path: string;
  readonly score: number;
  readonly description: string | null;
}

export interface DiscoverSourcePayload {
  readonly name: string;
  readonly kind: string;
  readonly endpoint: string;
}

export interface SourceDiscoveryResult {
  readonly name: string;
  readonly kind: string;
  readonly endpoint: string;
  readonly iconUrl: string | null;
  readonly tools: readonly SourceInspectionToolSummary[];
}

export interface WorkspaceOauthClient {
  readonly id: string;
  readonly workspaceId: string;
  readonly providerKey: string;
  readonly clientId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateWorkspaceOauthClientPayload {
  readonly providerKey: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface ConnectSourcePayload {
  readonly sourceId: string;
}

export interface ConnectSourceResult {
  readonly connected: boolean;
}

export interface ConnectSourceBatchPayload {
  readonly sourceIds: readonly string[];
}

export interface ConnectSourceBatchResult {
  readonly results: readonly { sourceId: string; connected: boolean }[];
}

export interface StartSourceOAuthPayload {
  readonly sourceId: string;
  readonly providerKey: string;
  readonly scopes: readonly string[];
  readonly redirectUri: string;
}

export interface StartSourceOAuthResult {
  readonly authorizationUrl: string;
}

export interface CompleteSourceOAuthResult {
  readonly completed: boolean;
}

export interface LocalInstallation {
  readonly workspaceId: string;
  readonly accountId: string;
}
