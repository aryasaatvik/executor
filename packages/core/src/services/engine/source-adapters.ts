// Source adapter composition — built from @executor/source-core + @executor/source-builtins
// instead of @executor/engine/src/runtime/sources/source-adapters/index.ts
import * as Schema from "effect/Schema";

import {
  createSourceAdapterComposition,
  type SourceAdapter,
} from "@executor/source-core";
import { externalSourceAdapters } from "@executor/source-builtins";

export type * from "@executor/source-core";

// NOTE: The engine's builtInSourceAdapters includes an "internal" adapter.
// For control-plane purposes, we use only external adapters.
// If internal adapter is needed, it can be added here.
export const builtInSourceAdapters = [
  ...externalSourceAdapters,
] as const satisfies readonly SourceAdapter[];

const composition = createSourceAdapterComposition(builtInSourceAdapters);

export const connectableSourceAdapters = composition.connectableSourceAdapters;
export const ConnectSourcePayloadSchema =
  composition.connectPayloadSchema as Schema.Schema<
    typeof composition.connectPayloadSchema.Type,
    any,
    never
  >;
export type ConnectSourcePayload = typeof ConnectSourcePayloadSchema.Type;

export const executorAddableSourceAdapters =
  composition.executorAddableSourceAdapters;
export const ExecutorAddSourceInputSchema =
  composition.executorAddInputSchema as Schema.Schema<
    typeof composition.executorAddInputSchema.Type,
    any,
    never
  >;
export type ExecutorAddSourceInput = typeof ExecutorAddSourceInputSchema.Type;

export const localConfigurableSourceAdapters =
  composition.localConfigurableSourceAdapters;

export const getSourceAdapter = composition.getSourceAdapter;
export const getSourceAdapterForSource = composition.getSourceAdapterForSource;
export const findSourceAdapterByProviderKey =
  composition.findSourceAdapterByProviderKey;
export const sourceBindingStateFromSource =
  composition.sourceBindingStateFromSource;
export const sourceAdapterCatalogKind = composition.sourceAdapterCatalogKind;
export const sourceAdapterRequiresInteractiveConnect =
  composition.sourceAdapterRequiresInteractiveConnect;
export const sourceAdapterUsesCredentialManagedAuth =
  composition.sourceAdapterUsesCredentialManagedAuth;
