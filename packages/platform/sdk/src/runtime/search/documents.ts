import type {
  SearchResultItem,
} from "#schema";
import type {
  ToolContract,
} from "@executor/codemode-core";

import type {
  LoadedSourceCatalogToolIndexEntry,
} from "../catalog/source/runtime";
import type {
  SearchDocument,
} from "./types";

const executableDetails = (tool: LoadedSourceCatalogToolIndexEntry) => {
  const display = tool.executable.display ?? {};
  return {
    protocol: display.protocol ?? tool.executable.pluginKey ?? null,
    method: display.method ?? null,
    pathTemplate: display.pathTemplate ?? null,
    rawToolId: display.rawToolId ?? tool.path.split(".").at(-1) ?? null,
    operationId: display.operationId ?? null,
    group: display.group ?? null,
    leaf: display.leaf ?? tool.path.split(".").at(-1) ?? null,
    tags: tool.capability.surface.tags ?? [],
  };
};

export const searchDocumentFromLoadedTool = (
  tool: LoadedSourceCatalogToolIndexEntry,
): SearchDocument => {
  const details = executableDetails(tool);
  const contract = tool.descriptor.contract
    ? ({
        ...tool.descriptor.contract,
      } satisfies ToolContract)
    : null;

  return {
    path: tool.path,
    sourceId: tool.source.id,
    sourceKey: tool.source.id,
    namespace: tool.searchNamespace,
    searchText: tool.searchText,
    title: tool.capability.surface.title ?? null,
    description:
      tool.capability.surface.summary
      ?? tool.capability.surface.description
      ?? null,
    interaction: tool.descriptor.interaction ?? "auto",
    protocol: details.protocol,
    method: details.method,
    pathTemplate: details.pathTemplate,
    rawToolId: details.rawToolId,
    operationId: details.operationId,
    group: details.group,
    leaf: details.leaf,
    tags: [...details.tags],
    inputTypePreview: tool.descriptor.contract?.inputTypePreview ?? null,
    outputTypePreview: tool.descriptor.contract?.outputTypePreview ?? null,
    contract,
    metadata: {
      protocol: details.protocol,
      method: details.method,
      pathTemplate: details.pathTemplate,
      rawToolId: details.rawToolId,
      operationId: details.operationId,
      group: details.group,
      leaf: details.leaf,
      tags: [...details.tags],
    },
  };
};

export const searchResultItemFromDocument = (input: {
  document: SearchDocument;
  score: number;
  includeSchemas: boolean;
  metadata?: Record<string, unknown>;
}): SearchResultItem => ({
  path: input.document.path,
  score: input.score,
  sourceKey: input.document.sourceKey,
  ...(input.document.description
    ? { description: input.document.description }
    : {}),
  interaction: input.document.interaction,
  ...(input.document.contract
    ? {
        contract: input.includeSchemas
          ? input.document.contract
          : {
              ...(input.document.contract.inputTypePreview !== undefined
                ? { inputTypePreview: input.document.contract.inputTypePreview }
                : {}),
              ...(input.document.contract.outputTypePreview !== undefined
                ? { outputTypePreview: input.document.contract.outputTypePreview }
                : {}),
              ...(input.document.contract.exampleInput !== undefined
                ? { exampleInput: input.document.contract.exampleInput }
                : {}),
              ...(input.document.contract.exampleOutput !== undefined
                ? { exampleOutput: input.document.contract.exampleOutput }
                : {}),
            },
      }
    : {}),
  metadata: {
    ...input.document.metadata,
    ...(input.metadata ?? {}),
  },
});
