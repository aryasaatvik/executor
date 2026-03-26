import type { AccountId, Source } from "../../model/index";
import type { OnElicitation } from "@executor/codemode-core";
import * as Effect from "effect/Effect";

import { runtimeEffectError } from "./effect-errors";

// TODO: These types are engine internals not available via @executor/engine exports.
// They should migrate to control-plane or a shared contract package.
// For now, we define local placeholder types to allow compilation.

/** Placeholder for engine's LoadedSourceCatalogToolIndexEntry */
export type LoadedSourceCatalogToolIndexEntry = {
  path: string;
  searchNamespace: string;
  searchText: string;
  source: Source & { namespace?: string | null };
  capabilityId: string;
  executableId: string;
  capability: {
    id: string;
    surface: {
      title?: string | null;
      summary?: string | null;
      description?: string | null;
    };
    semantics: {
      effect: string;
    };
  };
  executable: {
    id: string;
    adapterKey: string;
    display?: { title?: string | null } | null;
  };
  descriptor: {
    sourceKey: string;
    interaction?: string | null;
    contract?: {
      inputSchema?: unknown;
      outputSchema?: unknown;
      inputTypePreview?: string;
      outputTypePreview?: string;
    } | null;
    providerKind?: string | null;
  };
  projectedCatalog: unknown;
};

/** Placeholder for engine's ResolvedSourceAuthMaterial */
export type ResolvedSourceAuthMaterial = {
  kind: string;
  [key: string]: unknown;
};

/** Placeholder for engine's SourceAdapter */
type SourceAdapter = {
  key: string;
  invoke: (input: {
    source: unknown;
    capability: unknown;
    executable: unknown;
    descriptor: unknown;
    catalog: unknown;
    args: unknown;
    auth: unknown;
    onElicitation?: OnElicitation;
    context?: Record<string, unknown>;
  }) => Effect.Effect<unknown, unknown>;
};

// TODO: Replace with proper source adapter resolution from @executor/sources
let _getSourceAdapter: ((key: string) => SourceAdapter) | undefined;

export const setSourceAdapterResolver = (
  resolver: (key: string) => SourceAdapter,
): void => {
  _getSourceAdapter = resolver;
};

const getSourceAdapter = (key: string): SourceAdapter => {
  if (!_getSourceAdapter) {
    throw new Error(
      "Source adapter resolver not configured. Call setSourceAdapterResolver() during startup.",
    );
  }
  return _getSourceAdapter(key);
};

export const invocationDescriptorFromTool = (input: {
  tool: LoadedSourceCatalogToolIndexEntry;
}): {
  toolPath: string;
  sourceId: Source["id"];
  sourceName: Source["name"];
  sourceKind: Source["kind"];
  sourceNamespace: string | null;
  operationKind: "read" | "write" | "delete" | "execute" | "unknown";
  interaction: "auto" | "required";
  approvalLabel: string | null;
} => ({
  toolPath: input.tool.path,
  sourceId: input.tool.source.id,
  sourceName: input.tool.source.name,
  sourceKind: input.tool.source.kind,
  sourceNamespace: input.tool.source.namespace ?? null,
  operationKind:
    input.tool.capability.semantics.effect === "read"
      ? "read"
      : input.tool.capability.semantics.effect === "write"
        ? "write"
        : input.tool.capability.semantics.effect === "delete"
          ? "delete"
          : input.tool.capability.semantics.effect === "action"
            ? "execute"
            : "unknown",
  interaction: (input.tool.descriptor.interaction ?? "auto") as "auto" | "required",
  approvalLabel: input.tool.capability.surface.title ?? input.tool.executable.display?.title ?? null,
});

export const invokeIrTool = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  tool: LoadedSourceCatalogToolIndexEntry;
  auth: ResolvedSourceAuthMaterial;
  args: unknown;
  onElicitation?: OnElicitation;
  context?: Record<string, unknown>;
}) => {
  const adapter = getSourceAdapter(input.tool.executable.adapterKey);
  if (adapter.key !== input.tool.source.kind) {
    return Effect.fail(
      runtimeEffectError("execution/ir-execution",
        `Executable ${input.tool.executable.id} expects adapter ${adapter.key}, but source ${input.tool.source.id} is ${input.tool.source.kind}`,
      ),
    );
  }

  return adapter.invoke({
    source: input.tool.source,
    capability: input.tool.capability,
    executable: input.tool.executable,
    descriptor: input.tool.descriptor,
    catalog: input.tool.projectedCatalog,
    args: input.args,
    auth: input.auth,
    onElicitation: input.onElicitation,
    context: input.context,
  });
};
