// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

export type SourceKind = string;

export type SourceStatus =
  | "draft"
  | "probing"
  | "auth_required"
  | "connected"
  | "error";

export type SourceImportAuthPolicy = "none" | "reuse_runtime" | "separate";

export type SourceAuth =
  | { readonly kind: "none" }
  | {
      readonly kind: "bearer";
      readonly headerName: string;
      readonly prefix: string;
      readonly token: SecretRef;
    }
  | {
      readonly kind: "oauth2";
      readonly headerName: string;
      readonly prefix: string;
      readonly accessToken: SecretRef;
      readonly refreshToken: SecretRef | null;
    }
  | {
      readonly kind: "oauth2_authorized_user";
      readonly headerName: string;
      readonly prefix: string;
      readonly tokenEndpoint: string;
      readonly clientId: string;
      readonly clientAuthentication: "none" | "client_secret_post";
      readonly clientSecret: SecretRef | null;
      readonly refreshToken: SecretRef;
      readonly grantSet: readonly string[] | null;
    }
  | {
      readonly kind: "provider_grant_ref";
      readonly grantId: string;
      readonly providerKey: string;
      readonly requiredScopes: readonly string[];
      readonly headerName: string;
      readonly prefix: string;
    }
  | {
      readonly kind: "mcp_oauth";
      readonly redirectUri: string;
      readonly accessToken: SecretRef;
      readonly refreshToken: SecretRef | null;
      readonly tokenType: string;
      readonly expiresIn: number | null;
      readonly scope: string | null;
      readonly resourceMetadataUrl: string | null;
      readonly authorizationServerUrl: string | null;
      readonly resourceMetadataJson: string | null;
      readonly authorizationServerMetadataJson: string | null;
      readonly clientInformationJson: string | null;
    };

export interface SecretRef {
  readonly providerId: string;
  readonly handle: string;
}

export interface Source {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly kind: SourceKind;
  readonly endpoint: string;
  readonly status: SourceStatus;
  readonly enabled: boolean;
  readonly namespace: string | null;
  readonly iconUrl: string | null;
  readonly bindingVersion: number;
  readonly binding: Record<string, unknown>;
  readonly importAuthPolicy: SourceImportAuthPolicy;
  readonly importAuth: SourceAuth;
  readonly auth: SourceAuth;
  readonly sourceHash: string | null;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ---------------------------------------------------------------------------
// Source request payloads
// ---------------------------------------------------------------------------

export interface CreateSourceRequest {
  readonly name: string;
  readonly kind: SourceKind;
  readonly endpoint: string;
  readonly status?: SourceStatus;
  readonly enabled?: boolean;
  readonly namespace?: string | null;
  readonly iconUrl?: string | null;
  readonly binding?: Record<string, unknown>;
  readonly importAuthPolicy?: SourceImportAuthPolicy;
  readonly importAuth?: SourceAuth;
  readonly auth?: SourceAuth;
  readonly sourceHash?: string | null;
  readonly lastError?: string | null;
}

export interface UpdateSourceRequest {
  readonly name?: string;
  readonly endpoint?: string;
  readonly status?: SourceStatus;
  readonly enabled?: boolean;
  readonly namespace?: string | null;
  readonly iconUrl?: string | null;
  readonly binding?: Record<string, unknown>;
  readonly importAuthPolicy?: SourceImportAuthPolicy;
  readonly importAuth?: SourceAuth;
  readonly auth?: SourceAuth;
  readonly sourceHash?: string | null;
  readonly lastError?: string | null;
}

// ---------------------------------------------------------------------------
// Tool search
// ---------------------------------------------------------------------------

export type ToolSearchMode = "exact" | "search";
export type ToolSearchBackendMode = "fts" | "semantic" | "hybrid";

export interface ToolSearchResult {
  readonly path: string;
  readonly score: number;
  readonly sourceKey: string;
  readonly namespace: string;
  readonly description?: string;
  readonly inputTypePreview?: string;
  readonly outputTypePreview?: string;
}

export interface ToolSearchMeta {
  readonly query: string;
  readonly mode: ToolSearchMode;
  readonly searchMode: ToolSearchBackendMode;
  readonly total: number;
  readonly source: string | null;
  readonly namespace: string | null;
  readonly limit: number;
}

export interface ToolSearchResultSet {
  readonly meta: ToolSearchMeta;
  readonly results: readonly ToolSearchResult[];
}

export interface ToolSearchRequest {
  readonly query: string;
  readonly source?: string | null;
  readonly namespace?: string | null;
  readonly limit?: number;
}
