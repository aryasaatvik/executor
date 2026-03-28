// SecretMaterialStore — copied from @executor/engine/src/runtime/local/secret-material-providers.ts
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { SecretMaterialPurpose, SecretRef, SecretMaterialId } from "../../model/index";
import { SecretMaterialIdSchema } from "../../model/index";
import type { EngineStoreShape } from "./store";

export type SecretMaterialResolveContext = {
  params?: Readonly<Record<string, string | undefined>>;
};

export type ResolveSecretMaterial = (input: {
  ref: SecretRef;
  context?: SecretMaterialResolveContext;
}) => Effect.Effect<string, Error, never>;

export type StoreSecretMaterial = (input: {
  purpose: SecretMaterialPurpose;
  value: string;
  name?: string | null;
  providerId?: string;
}) => Effect.Effect<SecretRef, Error, never>;

export type DeleteSecretMaterial = (
  ref: SecretRef,
) => Effect.Effect<boolean, Error, never>;

export type SecretMaterialStoreShape = {
  resolve: ResolveSecretMaterial;
  getById: (id: SecretMaterialId) => Effect.Effect<
    Option.Option<SecretMaterialSummary>,
    Error,
    never
  >;
  listAll: () => Effect.Effect<readonly SecretMaterialSummary[], Error, never>;
  store: StoreSecretMaterial;
  update: (input: {
    ref: SecretRef;
    name?: string | null;
    value?: string;
  }) => Effect.Effect<
    {
      id: string;
      providerId: string;
      name: string | null;
      purpose: string;
      createdAt: number;
      updatedAt: number;
    },
    Error,
    never
  >;
  remove: DeleteSecretMaterial;
};

export type SecretMaterialSummary = {
  id: string;
  providerId: string;
  name: string | null;
  purpose: string;
  createdAt: number;
  updatedAt: number;
};

export class SecretMaterialStore extends Context.Tag(
  "#runtime/SecretMaterialStore",
)<SecretMaterialStore, SecretMaterialStoreShape>() {}

/**
 * Create a default secret material storer that persists via EngineStore.
 * This is a simplified version of the engine's createDefaultSecretMaterialStorer
 * that always uses the "local" provider backed by the engine's secret store.
 */
export const createDefaultSecretMaterialStorer = (input: {
  rows: EngineStoreShape;
}): StoreSecretMaterial =>
  ({ purpose, value, name }) =>
    Effect.gen(function* () {
      const id = SecretMaterialIdSchema.make(crypto.randomUUID()) as SecretMaterialId;
      const now = Date.now();
      yield* input.rows.secretMaterials.upsert({
        id,
        providerId: "local",
        handle: id as string,
        name: name ?? null,
        purpose,
        value,
        createdAt: now,
        updatedAt: now,
      });
      return {
        providerId: "local",
        handle: id as string,
      } satisfies SecretRef;
    });

/**
 * Create a default secret material deleter that removes via EngineStore.
 */
export const createDefaultSecretMaterialDeleter = (input: {
  rows: EngineStoreShape;
}): DeleteSecretMaterial =>
  (ref) =>
    Effect.gen(function* () {
      if (ref.providerId !== "local") {
        return false;
      }
      return yield* input.rows.secretMaterials.removeById(
        ref.handle as SecretMaterialId,
      );
    });
