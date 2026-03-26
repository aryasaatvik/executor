import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { SecretMaterial, SecretMaterialPurpose } from "../model/index";

// TODO: Migrate to ServiceMap.Service when moving to Effect v4

export interface SecretStoreShape {
  readonly list: () => Effect.Effect<ReadonlyArray<SecretMaterial>, Error>;

  readonly getByHandle: (input: {
    providerId: string;
    handle: string;
  }) => Effect.Effect<SecretMaterial | null, Error>;

  readonly resolve: (input: {
    providerId: string;
    handle: string;
  }) => Effect.Effect<string | null, Error>;

  readonly create: (input: {
    name: string;
    value: string;
    purpose?: SecretMaterialPurpose;
    providerId?: string;
  }) => Effect.Effect<SecretMaterial, Error>;

  readonly update: (input: {
    id: string;
    name?: string;
    value?: string;
  }) => Effect.Effect<SecretMaterial, Error>;

  readonly remove: (input: {
    id: string;
  }) => Effect.Effect<boolean, Error>;
}

export class SecretStore extends Context.Tag(
  "@executor/control-plane/SecretStore",
)<SecretStore, SecretStoreShape>() {}
