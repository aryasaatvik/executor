import type { AccountId, Source } from "../../model/index";
import type { OnElicitation } from "@executor/codemode-core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type {
  LoadedSourceCatalogToolIndexEntry as RuntimeLoadedSourceCatalogToolIndexEntry,
} from "../sources/source-inspection";
import type { ResolvedSourceAuthMaterial as RuntimeResolvedSourceAuthMaterial } from "../auth/source-auth-material";
import type { ExecutionSourceAdapterRegistryShape } from "./contracts";
import { runtimeEffectError } from "./effect-errors";

export type LoadedSourceCatalogToolIndexEntry =
  RuntimeLoadedSourceCatalogToolIndexEntry;

export type ResolvedSourceAuthMaterial = RuntimeResolvedSourceAuthMaterial;

export class ExecutionSourceAdapterResolver extends Context.Tag(
  "#runtime/ExecutionSourceAdapterResolver",
)<ExecutionSourceAdapterResolver, ExecutionSourceAdapterRegistryShape>() {}

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
}) =>
  Effect.gen(function* () {
    const adapterResolver = yield* ExecutionSourceAdapterResolver;
    const adapter = adapterResolver.getSourceAdapter(input.tool.executable.adapterKey);
    if (adapter.key !== input.tool.source.kind) {
      return yield* Effect.fail(
        runtimeEffectError(
          "execution/ir-execution",
          `Executable ${input.tool.executable.id} expects adapter ${adapter.key}, but source ${input.tool.source.id} is ${input.tool.source.kind}`,
        ),
      );
    }

    return yield* adapter.invoke({
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
  });
