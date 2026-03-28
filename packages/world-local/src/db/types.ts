/**
 * Type aliases for Drizzle column $type<> annotations that are not
 * re-exported from @executor/core/model.
 *
 * These are thin branded string types used only at the Drizzle schema
 * level for SQLite column typing. The canonical Effect Schema definitions
 * live in the engine's schema package.
 */

import type {
  AuthArtifactSlot,
  ProviderAuthGrant,
} from "@executor/core/model";
import { Schema } from "effect";

/** Credential slot — alias for AuthArtifactSlot at the Drizzle layer. */
export type CredentialSlot = AuthArtifactSlot;

/** Source auth session provider kind — opaque string at the DB level. */
export type SourceAuthSessionProviderKind = string;

/** Source auth session status. */
export type SourceAuthSessionStatus =
  | "pending"
  | "completed"
  | "failed"
  | "cancelled";

const WorkspaceSourceOauthClientIdSchema = Schema.String.pipe(
  Schema.brand("WorkspaceSourceOauthClientId"),
);

/** Source-level OAuth client ID (branded string). */
export type WorkspaceSourceOauthClientId = typeof WorkspaceSourceOauthClientIdSchema.Type;

/** Local workspace policy effect — matches engine's LocalWorkspacePolicyEffect. */
export type LocalWorkspacePolicyEffect = "allow" | "deny";

/** Local workspace policy approval mode — matches engine's LocalWorkspacePolicyApprovalMode. */
export type LocalWorkspacePolicyApprovalMode = "auto" | "required";
