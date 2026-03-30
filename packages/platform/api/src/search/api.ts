import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import {
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
  ControlPlaneNotFoundError,
  ControlPlaneStorageError,
  ControlPlaneUnauthorizedError,
} from "@executor/platform-sdk/errors";
import {
  ScopeIdSchema as WorkspaceIdSchema,
  SearchProviderStatusSchema,
} from "@executor/platform-sdk/schema";

export { SearchProviderStatusSchema };
export type { SearchProviderStatus } from "@executor/platform-sdk/schema";

const workspaceIdParam = HttpApiSchema.param("workspaceId", WorkspaceIdSchema);

export class SearchApi extends HttpApiGroup.make("search")
  .add(
    HttpApiEndpoint.get("status")`/workspaces/${workspaceIdParam}/search/status`
      .addSuccess(SearchProviderStatusSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("refresh")`/workspaces/${workspaceIdParam}/search/refresh`
      .addSuccess(SearchProviderStatusSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("rebuild")`/workspaces/${workspaceIdParam}/search/rebuild`
      .addSuccess(SearchProviderStatusSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .prefix("/v1") {}
