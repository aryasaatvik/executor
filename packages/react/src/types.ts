import type {
  SecretRef,
  SourceInspection,
  SourceInspectionDiscoverResult,
  SourceInspectionToolDetail,
  SourceTransport,
  StringMap,
  WorkspaceOauthClient,
  Source,
} from "@executor/core/model";
import type {
  SourceDiscoveryResult,
  SourceOauthClientInput,
  SourceProbeAuth,
} from "@executor/source-core";

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
// Local API shapes not yet published from @executor/api.
// ---------------------------------------------------------------------------

export interface SecretProvider {
  readonly id: string;
  readonly name: string;
  readonly canStore: boolean;
}

export interface InstanceConfig {
  readonly platform: string;
  readonly secretProviders: readonly SecretProvider[];
  readonly defaultSecretStoreProvider: string;
  readonly semanticSearch: {
    readonly provider: string;
    readonly model?: string;
    readonly apiKeyRef?: SecretRef;
    readonly dimensions?: number;
  } | null;
}

export type { SourceInspection, SourceInspectionToolDetail, SourceInspectionDiscoverResult };

export interface DiscoverSourcePayload {
  readonly url: string;
  readonly probeAuth?: SourceProbeAuth;
}

export type { SourceDiscoveryResult, WorkspaceOauthClient };

export interface CreateWorkspaceOauthClientPayload {
  readonly providerKey: string;
  readonly label?: string | null;
  readonly oauthClient: SourceOauthClientInput;
}

export type HttpConnectAuth =
  | { readonly kind: "none" }
  | {
      readonly kind: "bearer";
      readonly headerName?: string | null;
      readonly prefix?: string | null;
      readonly token?: string | null;
      readonly tokenRef?: SecretRef | null;
    }
  | {
      readonly kind: "oauth2";
      readonly headerName?: string | null;
      readonly prefix?: string | null;
      readonly accessTokenRef?: SecretRef | null;
      readonly refreshTokenRef?: SecretRef | null;
    };

export type ConnectSourcePayload =
  | {
      readonly kind: "mcp";
      readonly endpoint: string;
      readonly name?: string | null;
      readonly namespace?: string | null;
      readonly transport?: SourceTransport;
      readonly queryParams?: StringMap | null;
      readonly headers?: StringMap | null;
      readonly command?: string | null;
      readonly args?: readonly string[] | null;
      readonly env?: StringMap | null;
      readonly cwd?: string | null;
    }
  | {
      readonly kind: "openapi";
      readonly endpoint: string;
      readonly specUrl: string;
      readonly name?: string | null;
      readonly namespace?: string | null;
      readonly importAuthPolicy?: string;
      readonly importAuth?: HttpConnectAuth;
      readonly auth?: HttpConnectAuth;
    }
  | {
      readonly kind: "graphql";
      readonly endpoint: string;
      readonly name?: string | null;
      readonly namespace?: string | null;
      readonly importAuthPolicy?: string;
      readonly importAuth?: HttpConnectAuth;
      readonly auth?: HttpConnectAuth;
    }
  | {
      readonly kind: "google_discovery";
      readonly service: string;
      readonly version: string;
      readonly discoveryUrl?: string | null;
      readonly scopes?: readonly string[] | null;
      readonly oauthClient?: SourceOauthClientInput | null;
      readonly workspaceOauthClientId?: WorkspaceOauthClient["id"];
      readonly name?: string | null;
      readonly namespace?: string | null;
      readonly importAuthPolicy?: string;
      readonly importAuth?: HttpConnectAuth;
      readonly auth?: HttpConnectAuth;
    };

export type ConnectSourceResult =
  | {
      readonly kind: "connected";
      readonly source: Source;
    }
  | {
      readonly kind: "credential_required";
      readonly source: Source;
      readonly credentialSlot: "runtime" | "import";
    }
  | {
      readonly kind: "oauth_required";
      readonly source: Source;
      readonly sessionId: string;
      readonly authorizationUrl: string;
    };

export interface ConnectSourceBatchPayload {
  readonly workspaceOauthClientId: WorkspaceOauthClient["id"];
  readonly sources: ReadonlyArray<{
    readonly service: string;
    readonly version: string;
    readonly discoveryUrl?: string | null;
    readonly scopes?: readonly string[];
    readonly name?: string | null;
    readonly namespace?: string | null;
  }>;
}

export interface ConnectSourceBatchResult {
  readonly results: ReadonlyArray<{
    readonly source: Source;
    readonly status: "connected" | "pending_oauth";
  }>;
  readonly providerOauthSession: {
    readonly sessionId: string;
    readonly authorizationUrl: string;
    readonly sourceIds: readonly string[];
  } | null;
}

export interface StartSourceOAuthPayload {
  readonly provider: "mcp";
  readonly name?: string | null;
  readonly endpoint: string;
  readonly transport?: SourceTransport;
  readonly queryParams?: StringMap | null;
  readonly headers?: StringMap | null;
}

export interface StartSourceOAuthResult {
  readonly sessionId: string;
  readonly authorizationUrl: string;
}

export interface CompleteSourceOAuthResult {
  readonly sessionId: string;
  readonly auth: {
    readonly kind: "oauth2";
    readonly headerName: string;
    readonly prefix: string;
    readonly accessToken: SecretRef;
    readonly refreshToken: SecretRef | null;
  };
}

export interface LocalInstallation {
  readonly workspaceId: string;
  readonly accountId: string;
}
