import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  AccountId,
  Source,
  SourceId,
  WorkspaceId,
} from "../model/index";

// TODO: Migrate to ServiceMap.Service when moving to Effect v4

export interface SourceStoreShape {
  readonly list: (input: {
    workspaceId: WorkspaceId;
    accountId?: AccountId | null;
  }) => Effect.Effect<ReadonlyArray<Source>, Error>;

  readonly getById: (input: {
    workspaceId: WorkspaceId;
    sourceId: SourceId;
    accountId?: AccountId | null;
  }) => Effect.Effect<Source | null, Error>;

  readonly create: (input: {
    workspaceId: WorkspaceId;
    source: Omit<Source, "id" | "createdAt" | "updatedAt">;
  }) => Effect.Effect<Source, Error>;

  readonly update: (input: {
    workspaceId: WorkspaceId;
    sourceId: SourceId;
    update: Partial<Source>;
  }) => Effect.Effect<Source, Error>;

  readonly remove: (input: {
    workspaceId: WorkspaceId;
    sourceId: SourceId;
  }) => Effect.Effect<boolean, Error>;
}

export class SourceStore extends Context.Tag(
  "@executor/control-plane/SourceStore",
)<SourceStore, SourceStoreShape>() {}
