import * as Effect from "effect/Effect";

import {
  type ToolCatalog,
  type ToolPath,
  createToolCatalogDiscovery,
} from "@executor/codemode-core";

const asToolPath = (value: string): ToolPath => value as ToolPath;

const catalog: ToolCatalog = {
  listNamespaces({ limit }) {
    return Effect.succeed([
      { namespace: "src_api", displayName: "API Sources", toolCount: 6800 },
      { namespace: "src_mcp", displayName: "MCP Sources", toolCount: 3200 },
    ].slice(0, limit));
  },
  listTools({ namespace }) {
    return Effect.succeed([
      {
        path: asToolPath("source.src_api.github.issues.list"),
        sourceKey: "source.src_api",
        description: "Hydrated metadata for selected path",
        inputTypePreview: "object",
        outputTypePreview: "object",
      },
    ].filter((tool) => !namespace || tool.path.startsWith(`source.${namespace}.`)));
  },
  getToolByPath({ path }) {
    return Effect.succeed({
      path,
      sourceKey: "source.src_api",
      description: "Hydrated metadata for selected path",
      inputTypePreview: "object",
      outputTypePreview: "object",
    });
  },
  searchTools({ limit }) {
    return Effect.succeed(
      [
        { path: asToolPath("source.src_api.github.issues.list"), score: 0.99 },
        { path: asToolPath("source.src_api.github.issues.create"), score: 0.92 },
      ].slice(0, limit),
    );
  },
};

export const dynamicDemo = createToolCatalogDiscovery({
  catalog,
});
