// ---------------------------------------------------------------------------
// Secret (public projection — no secret values exposed)
// ---------------------------------------------------------------------------

export type SecretMaterialPurpose =
  | "auth_material"
  | "oauth_access_token"
  | "oauth_refresh_token"
  | "oauth_client_info";

export interface SecretLinkedSource {
  readonly sourceId: string;
  readonly sourceName: string;
}

export interface SecretListItem {
  readonly id: string;
  readonly providerId: string;
  readonly name: string | null;
  readonly purpose: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly linkedSources: readonly SecretLinkedSource[];
}

// ---------------------------------------------------------------------------
// Secret request / response payloads
// ---------------------------------------------------------------------------

export interface CreateSecretRequest {
  readonly name: string;
  readonly value: string;
  readonly purpose?: SecretMaterialPurpose;
  readonly providerId?: string;
}

export interface CreateSecretResponse {
  readonly id: string;
  readonly name: string | null;
  readonly providerId: string;
  readonly purpose: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface UpdateSecretRequest {
  readonly name?: string;
  readonly value?: string;
}

export interface UpdateSecretResponse {
  readonly id: string;
  readonly providerId: string;
  readonly name: string | null;
  readonly purpose: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DeleteSecretResponse {
  readonly removed: boolean;
}
