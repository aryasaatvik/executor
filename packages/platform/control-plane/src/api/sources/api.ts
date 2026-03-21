import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import {
  SourceOauthClientInputSchema,
  ExecutionInteractionIdSchema,
  JsonObjectSchema,
  ProviderAuthGrantIdSchema,
  SourceAuthSchema,
  SourceAuthSessionIdSchema,
  SourceDiscoveryResultSchema,
  SourceIdSchema,
  SourceInspectionDiscoverPayloadSchema,
  SourceInspectionDiscoverResultSchema,
  SourceInspectionSchema,
  SourceInspectionToolDetailSchema,
  SourceImportAuthPolicySchema,
  SourceKindSchema,
  SourceProbeAuthSchema,
  SourceSchema,
  SourceStatusSchema,
  WorkspaceOauthClientIdSchema,
  WorkspaceOauthClientSchema,
  WorkspaceIdSchema,
} from "#schema";
import * as Schema from "effect/Schema";

import {
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
  ControlPlaneNotFoundError,
  ControlPlaneStorageError,
  ControlPlaneUnauthorizedError,
} from "../errors";
import {
  OptionalTrimmedNonEmptyStringSchema,
  TrimmedNonEmptyStringSchema,
} from "../string-schemas";
import {
  ConnectSourcePayloadSchema,
  type ConnectSourcePayload,
} from "../../runtime/sources/source-adapters";

const createSourcePayloadRequiredSchema = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  kind: SourceKindSchema,
  endpoint: TrimmedNonEmptyStringSchema,
});

const createSourcePayloadOptionalSchema = Schema.Struct({
  status: Schema.optional(SourceStatusSchema),
  enabled: Schema.optional(Schema.Boolean),
  namespace: Schema.optional(Schema.NullOr(Schema.String)),
  iconUrl: Schema.optional(Schema.NullOr(Schema.String)),
  binding: Schema.optional(JsonObjectSchema),
  importAuthPolicy: Schema.optional(SourceImportAuthPolicySchema),
  importAuth: Schema.optional(SourceAuthSchema),
  auth: Schema.optional(SourceAuthSchema),
  sourceHash: Schema.optional(Schema.NullOr(Schema.String)),
  lastError: Schema.optional(Schema.NullOr(Schema.String)),
});

export const CreateSourcePayloadSchema = Schema.extend(
  createSourcePayloadRequiredSchema,
  createSourcePayloadOptionalSchema,
);

export type CreateSourcePayload = typeof CreateSourcePayloadSchema.Type;
export type CreateWorkspaceOauthClientPayload =
  typeof CreateWorkspaceOauthClientPayloadSchema.Type;

export const UpdateSourcePayloadSchema = Schema.Struct({
  name: OptionalTrimmedNonEmptyStringSchema,
  endpoint: OptionalTrimmedNonEmptyStringSchema,
  status: Schema.optional(SourceStatusSchema),
  enabled: Schema.optional(Schema.Boolean),
  namespace: Schema.optional(Schema.NullOr(Schema.String)),
  iconUrl: Schema.optional(Schema.NullOr(Schema.String)),
  binding: Schema.optional(JsonObjectSchema),
  importAuthPolicy: Schema.optional(SourceImportAuthPolicySchema),
  importAuth: Schema.optional(SourceAuthSchema),
  auth: Schema.optional(SourceAuthSchema),
  sourceHash: Schema.optional(Schema.NullOr(Schema.String)),
  lastError: Schema.optional(Schema.NullOr(Schema.String)),
});

export type UpdateSourcePayload = typeof UpdateSourcePayloadSchema.Type;

const workspaceIdParam = HttpApiSchema.param("workspaceId", WorkspaceIdSchema);
const sourceIdParam = HttpApiSchema.param("sourceId", SourceIdSchema);
const toolPathParam = HttpApiSchema.param("toolPath", Schema.String);

const CredentialPageUrlParamsSchema = Schema.Struct({
  interactionId: ExecutionInteractionIdSchema,
});

const CredentialSubmitPayloadSchema = Schema.Struct({
  action: Schema.optional(Schema.Literal("submit", "continue", "cancel")),
  token: Schema.optional(Schema.String),
});

const CredentialOauthCompleteUrlParamsSchema = Schema.Struct({
  state: Schema.String,
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

const WorkspaceOauthClientQuerySchema = Schema.Struct({
  providerKey: Schema.String,
});

const CreateWorkspaceOauthClientPayloadSchema = Schema.Struct({
  providerKey: Schema.String,
  label: Schema.optional(Schema.NullOr(Schema.String)),
  oauthClient: SourceOauthClientInputSchema,
});

const oauthClientIdParam = HttpApiSchema.param("oauthClientId", WorkspaceOauthClientIdSchema);
const grantIdParam = HttpApiSchema.param("grantId", ProviderAuthGrantIdSchema);

const ConnectGoogleDiscoveryBatchSourceSchema = Schema.Struct({
  service: TrimmedNonEmptyStringSchema,
  version: TrimmedNonEmptyStringSchema,
  discoveryUrl: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  scopes: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  namespace: Schema.optional(Schema.NullOr(Schema.String)),
});

const ConnectSourceBatchPayloadSchema = Schema.Struct({
  workspaceOauthClientId: WorkspaceOauthClientIdSchema,
  sources: Schema.Array(ConnectGoogleDiscoveryBatchSourceSchema),
});

const ConnectSourceBatchResultSchema = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      source: SourceSchema,
      status: Schema.Literal("connected", "pending_oauth"),
    }),
  ),
  providerOauthSession: Schema.NullOr(
    Schema.Struct({
      sessionId: SourceAuthSessionIdSchema,
      authorizationUrl: Schema.String,
      sourceIds: Schema.Array(SourceIdSchema),
    }),
  ),
});

const DiscoverSourcePayloadSchema = Schema.Struct({
  url: TrimmedNonEmptyStringSchema,
  probeAuth: Schema.optional(SourceProbeAuthSchema),
});

export type DiscoverSourcePayload = typeof DiscoverSourcePayloadSchema.Type;

const ConnectSourceResultSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("connected"),
    source: SourceSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("credential_required"),
    source: SourceSchema,
    credentialSlot: Schema.Literal("runtime", "import"),
  }),
  Schema.Struct({
    kind: Schema.Literal("oauth_required"),
    source: SourceSchema,
    sessionId: SourceAuthSessionIdSchema,
    authorizationUrl: Schema.String,
  }),
);

export type ConnectSourceResult = typeof ConnectSourceResultSchema.Type;
export type ConnectSourceBatchPayload = typeof ConnectSourceBatchPayloadSchema.Type;
export type ConnectSourceBatchResult = typeof ConnectSourceBatchResultSchema.Type;

export {
  ConnectSourcePayloadSchema,
  ConnectSourceBatchPayloadSchema,
  ConnectSourceBatchResultSchema,
  ConnectSourceResultSchema,
  CreateWorkspaceOauthClientPayloadSchema,
  DiscoverSourcePayloadSchema,
};

export type { ConnectSourcePayload };

const HtmlSchema = HttpApiSchema.Text({
  contentType: "text/html",
});

export class SourcesApi extends HttpApiGroup.make("sources")
  .add(
    HttpApiEndpoint.post("discover")`/sources/discover`
      .setPayload(DiscoverSourcePayloadSchema)
      .addSuccess(SourceDiscoveryResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError),
  )
  .add(
    HttpApiEndpoint.post("connect")`/workspaces/${workspaceIdParam}/sources/connect`
      .setPayload(ConnectSourcePayloadSchema)
      .addSuccess(ConnectSourceResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("connectBatch")`/workspaces/${workspaceIdParam}/sources/connect-batch`
      .setPayload(ConnectSourceBatchPayloadSchema)
      .addSuccess(ConnectSourceBatchResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("listWorkspaceOauthClients")`/workspaces/${workspaceIdParam}/oauth-clients`
      .setUrlParams(WorkspaceOauthClientQuerySchema)
      .addSuccess(Schema.Array(WorkspaceOauthClientSchema))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("createWorkspaceOauthClient")`/workspaces/${workspaceIdParam}/oauth-clients`
      .setPayload(CreateWorkspaceOauthClientPayloadSchema)
      .addSuccess(WorkspaceOauthClientSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.del("removeWorkspaceOauthClient")`/workspaces/${workspaceIdParam}/oauth-clients/${oauthClientIdParam}`
      .addSuccess(Schema.Struct({ removed: Schema.Boolean }))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.del("removeProviderAuthGrant")`/workspaces/${workspaceIdParam}/provider-grants/${grantIdParam}`
      .addSuccess(Schema.Struct({ removed: Schema.Boolean }))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("list")`/workspaces/${workspaceIdParam}/sources`
      .addSuccess(Schema.Array(SourceSchema))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("create")`/workspaces/${workspaceIdParam}/sources`
      .setPayload(CreateSourcePayloadSchema)
      .addSuccess(SourceSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("get")`/workspaces/${workspaceIdParam}/sources/${sourceIdParam}`
      .addSuccess(SourceSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.patch("update")`/workspaces/${workspaceIdParam}/sources/${sourceIdParam}`
      .setPayload(UpdateSourcePayloadSchema)
      .addSuccess(SourceSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.del("remove")`/workspaces/${workspaceIdParam}/sources/${sourceIdParam}`
      .addSuccess(Schema.Struct({ removed: Schema.Boolean }))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("credentialPage")`/workspaces/${workspaceIdParam}/sources/${sourceIdParam}/credentials`
      .setUrlParams(CredentialPageUrlParamsSchema)
      .addSuccess(HtmlSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("credentialSubmit")`/workspaces/${workspaceIdParam}/sources/${sourceIdParam}/credentials`
      .setUrlParams(CredentialPageUrlParamsSchema)
      .setPayload(CredentialSubmitPayloadSchema)
      .addSuccess(HtmlSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("credentialComplete")`/workspaces/${workspaceIdParam}/sources/${sourceIdParam}/credentials/oauth/complete`
      .setUrlParams(CredentialOauthCompleteUrlParamsSchema)
      .addSuccess(HtmlSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("providerOauthComplete")`/workspaces/${workspaceIdParam}/oauth/provider/callback`
      .setUrlParams(CredentialOauthCompleteUrlParamsSchema)
      .addSuccess(HtmlSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("inspection")`/workspaces/${workspaceIdParam}/sources/${sourceIdParam}/inspection`
      .addSuccess(SourceInspectionSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("inspectionTool")`/workspaces/${workspaceIdParam}/sources/${sourceIdParam}/tools/${toolPathParam}/inspection`
      .addSuccess(SourceInspectionToolDetailSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("inspectionDiscover")`/workspaces/${workspaceIdParam}/sources/${sourceIdParam}/inspection/discover`
      .setPayload(SourceInspectionDiscoverPayloadSchema)
      .addSuccess(SourceInspectionDiscoverResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .prefix("/v1") {}
