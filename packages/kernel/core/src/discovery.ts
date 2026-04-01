import * as Effect from "effect/Effect";

import { toolDescriptorsFromTools } from "./tool-map";
import type {
  CatalogPrimitive,
  DescribePrimitive,
  DiscoverPrimitive,
  DiscoveryPrimitives,
  SearchHit,
  ToolSearchResult,
  ToolCatalog,
  ToolCatalogEntry,
  ToolDescriptor,
  ToolMap,
  ToolNamespace,
  ToolPath,
} from "./types";

const tokenize = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/\W+/)
    .map((token) => token.trim())
    .filter(Boolean);

const searchableTextForTool = (tool: ToolDescriptor): string =>
  [
    tool.path,
    tool.sourceKey,
    tool.description ?? "",
    tool.contract?.inputTypePreview ?? "",
    tool.contract?.outputTypePreview ?? "",
  ]
    .join(" ")
    .toLowerCase();

const descriptorContract = (
  descriptor: ToolDescriptor,
  includeSchemas: boolean,
): ToolDescriptor["contract"] | undefined => {
  const contract = descriptor.contract;
  if (!contract) {
    return undefined;
  }

  if (includeSchemas) {
    return contract;
  }

  return {
    ...(contract.inputTypePreview !== undefined
      ? { inputTypePreview: contract.inputTypePreview }
      : {}),
    ...(contract.outputTypePreview !== undefined
      ? { outputTypePreview: contract.outputTypePreview }
      : {}),
    ...(contract.exampleInput !== undefined
      ? { exampleInput: contract.exampleInput }
      : {}),
    ...(contract.exampleOutput !== undefined
      ? { exampleOutput: contract.exampleOutput }
      : {}),
  };
};

const projectDescriptor = (input: {
  descriptor: ToolDescriptor;
  includeSchemas: boolean;
}): ToolDescriptor => {
  const { descriptor, includeSchemas } = input;

  if (includeSchemas) {
    return descriptor;
  }

  return {
    ...descriptor,
    ...(descriptorContract(descriptor, false)
      ? { contract: descriptorContract(descriptor, false) }
      : {}),
  };
};

const formatToolLine = (tool: ToolDescriptor): string =>
  tool.description && tool.description.trim().length > 0
    ? `- ${tool.path}: ${tool.description.trim()}`
    : `- ${tool.path}`;

const namespaceFromPath = (path: string): string => {
  const [first, second] = path.split(".");
  return second ? `${first}.${second}` : first;
};

const namespaceFromCatalogEntry = (entry: ToolCatalogEntry): string =>
  entry.namespace ?? namespaceFromPath(entry.descriptor.path);

const searchableTextForEntry = (entry: ToolCatalogEntry): string =>
  entry.searchText?.trim().toLowerCase() || searchableTextForTool(entry.descriptor);

const scoreCatalogEntry = (
  queryTokens: readonly string[],
  entry: ToolCatalogEntry,
): number => {
  if (entry.score) {
    return entry.score(queryTokens);
  }

  const haystack = searchableTextForEntry(entry);
  return queryTokens.reduce(
    (total, token) => total + (haystack.includes(token) ? 1 : 0),
    0,
  );
};

const mergeToolNamespaces = (
  groups: ReadonlyArray<readonly ToolNamespace[]>,
): ToolNamespace[] => {
  const merged = new Map<string, ToolNamespace>();

  for (const group of groups) {
    for (const namespace of group) {
      const existing = merged.get(namespace.namespace);
      merged.set(namespace.namespace, {
        namespace: namespace.namespace,
        displayName: existing?.displayName ?? namespace.displayName,
        ...(existing?.toolCount !== undefined || namespace.toolCount !== undefined
          ? {
              toolCount:
                (existing?.toolCount ?? 0) + (namespace.toolCount ?? 0),
            }
          : {}),
      });
    }
  }

  return [...merged.values()].sort((left, right) =>
    left.namespace.localeCompare(right.namespace),
  );
};

const dedupeToolDescriptors = (
  groups: ReadonlyArray<readonly ToolDescriptor[]>,
): ToolDescriptor[] => {
  const merged = new Map<string, ToolDescriptor>();

  for (const group of groups) {
    for (const descriptor of group) {
      if (!merged.has(descriptor.path)) {
        merged.set(descriptor.path, descriptor);
      }
    }
  }

  return [...merged.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
};

const dedupeSearchHits = (
  groups: ReadonlyArray<readonly SearchHit[]>,
): SearchHit[] => {
  const merged = new Map<string, SearchHit>();

  for (const group of groups) {
    for (const hit of group) {
      if (!merged.has(hit.path)) {
        merged.set(hit.path, hit);
      }
    }
  }

  return [...merged.values()].sort(
    (left, right) => right.score - left.score || left.path.localeCompare(right.path),
  );
};

export function createToolCatalogFromTools(input: {
  tools: ToolMap;
  defaultNamespace?: string;
}): ToolCatalog {
  return createToolCatalogFromEntries({
    entries: toolDescriptorsFromTools({
      tools: input.tools,
    }).map((descriptor) => ({
      descriptor,
      ...(input.defaultNamespace !== undefined
        ? { namespace: input.defaultNamespace }
        : {}),
    })),
  });
}

export function createToolCatalogFromEntries(input: {
  entries: ReadonlyArray<ToolCatalogEntry>;
}): ToolCatalog {
  const entries = [...input.entries];
  const byPath = new Map(
    entries.map((entry) => [entry.descriptor.path as string, entry]),
  );
  const namespaceCounts = new Map<string, number>();

  for (const entry of entries) {
    const namespace = namespaceFromCatalogEntry(entry);
    namespaceCounts.set(namespace, (namespaceCounts.get(namespace) ?? 0) + 1);
  }

  return {
    listNamespaces: ({ limit }) =>
      Effect.succeed(
        [...namespaceCounts.entries()]
          .map(([namespace, toolCount]) => ({ namespace, toolCount }))
          .slice(0, limit),
      ),
    listTools: ({ namespace, query, limit, includeSchemas = false }) =>
      Effect.succeed(
        entries
          .filter((entry) =>
            !namespace || namespaceFromCatalogEntry(entry) === namespace,
          )
          .filter((entry) => {
            if (!query) {
              return true;
            }

            const haystack = searchableTextForEntry(entry);
            return tokenize(query).every((token) => haystack.includes(token));
          })
          .slice(0, limit)
          .map((entry) =>
            projectDescriptor({
              descriptor: entry.descriptor,
              includeSchemas,
            })
          ),
      ),
    getToolByPath: ({ path, includeSchemas }) =>
      Effect.succeed(
        byPath.get(path)
          ? projectDescriptor({
              descriptor: byPath.get(path)!.descriptor,
              includeSchemas,
            })
          : null,
      ),
    searchTools: ({ query, namespace, limit, includeSchemas = false }) => {
      const queryTokens = tokenize(query);

      return Effect.succeed(
        (() => {
          const results = entries
            .filter((entry) =>
              !namespace || namespaceFromCatalogEntry(entry) === namespace,
            )
            .map((entry) => ({
              entry,
              score: scoreCatalogEntry(queryTokens, entry),
            }))
            .filter((item) => item.score > 0)
            .sort((left, right) => right.score - left.score)
            .slice(0, limit)
            .map(({ entry, score }) => {
              const descriptor = projectDescriptor({
                descriptor: entry.descriptor,
                includeSchemas,
              });

              return {
                path: descriptor.path,
                score,
                sourceKey: descriptor.sourceKey,
                description: descriptor.description,
                interaction: descriptor.interaction,
                ...(descriptorContract(descriptor, includeSchemas)
                  ? { contract: descriptorContract(descriptor, includeSchemas) }
                  : {}),
              } satisfies SearchHit;
            });

          return {
            providerKey: "catalog",
            mode: "lexical",
            backend: "in-memory",
            fallbackUsed: false,
            bestPath: results[0]?.path ?? null,
            total: results.length,
            results,
          } satisfies ToolSearchResult;
        })(),
      );
    },
  } satisfies ToolCatalog;
}

export function mergeToolCatalogs(input: {
  catalogs: ReadonlyArray<ToolCatalog>;
}): ToolCatalog {
  const catalogs = [...input.catalogs];

  return {
    listNamespaces: ({ limit }) =>
      Effect.gen(function* () {
        const groups = yield* Effect.forEach(
          catalogs,
          (catalog) => catalog.listNamespaces({ limit: Math.max(limit, limit * catalogs.length) }),
          { concurrency: "unbounded" },
        );

        return mergeToolNamespaces(groups).slice(0, limit);
      }),

    listTools: ({ namespace, query, limit, includeSchemas = false }) =>
      Effect.gen(function* () {
        const groups = yield* Effect.forEach(
          catalogs,
          (catalog) =>
            catalog.listTools({
              ...(namespace !== undefined ? { namespace } : {}),
              ...(query !== undefined ? { query } : {}),
              limit: Math.max(limit, limit * catalogs.length),
              includeSchemas,
            }),
          { concurrency: "unbounded" },
        );

        return dedupeToolDescriptors(groups).slice(0, limit);
      }),

    getToolByPath: ({ path, includeSchemas }) =>
      Effect.gen(function* () {
        for (const catalog of catalogs) {
          const descriptor = yield* catalog.getToolByPath({ path, includeSchemas });
          if (descriptor) {
            return descriptor;
          }
        }

        return null;
      }),

    searchTools: ({ query, namespace, limit, includeSchemas = false }) =>
      Effect.gen(function* () {
        const groups = yield* Effect.forEach(
          catalogs,
          (catalog) =>
            catalog.searchTools({
              query,
              ...(namespace !== undefined ? { namespace } : {}),
              limit: Math.max(limit, limit * catalogs.length),
              includeSchemas,
            }),
          { concurrency: "unbounded" },
        );

        const results = dedupeSearchHits(groups.map((group) => group.results)).slice(0, limit);
        const first = groups[0];

        return {
          providerKey: first?.providerKey,
          mode: first?.mode,
          backend: first?.backend,
          fallbackUsed: groups.some((group) => group.fallbackUsed === true),
          bestPath: results[0]?.path ?? null,
          total: results.length,
          results,
        } satisfies ToolSearchResult;
      }),
  } satisfies ToolCatalog;
}

export function createStaticDiscoveryFromTools(input: {
  tools: ToolMap;
  sourceKey?: string;
}): {
  tools: ToolDescriptor[];
  executeDescription: Effect.Effect<string, never>;
} {
  const tools = toolDescriptorsFromTools({
    tools: input.tools,
    sourceKey: input.sourceKey,
  });

  return {
    tools,
    executeDescription: Effect.succeed(buildStaticExecuteDescription({ tools })),
  };
}

export function createToolCatalogDiscovery(input: {
  catalog: ToolCatalog;
}): {
  primitives: DiscoveryPrimitives;
  executeDescription: Effect.Effect<string, unknown>;
} {
  const primitives = createDiscoveryPrimitivesFromToolCatalog({
    catalog: input.catalog,
  });

  return {
    primitives,
    executeDescription: buildDynamicExecuteDescription({
      catalog: input.catalog,
    }),
  };
}

export function createDiscoveryPrimitivesFromToolCatalog(input: {
  catalog: ToolCatalog;
}): DiscoveryPrimitives {
  const { catalog } = input;

  const describe: DescribePrimitive = {
    tool: ({ path, includeSchemas = false }) =>
      catalog.getToolByPath({ path, includeSchemas }),
  };

  const discover: DiscoverPrimitive = ({
    query,
    sourceKey: _sourceKey,
    limit = 12,
    includeSchemas = false,
  }) =>
    catalog.searchTools({
      query,
      limit,
      includeSchemas,
    });

  const catalogPrimitive: CatalogPrimitive = {
    namespaces: ({ limit = 200 }) =>
      catalog.listNamespaces({ limit }).pipe(
        Effect.map((namespaces) => ({ namespaces })),
      ),
    tools: ({ namespace, query, limit = 200, includeSchemas = false }) =>
      catalog.listTools({
        ...(namespace !== undefined ? { namespace } : {}),
        ...(query !== undefined ? { query } : {}),
        limit,
        includeSchemas,
      }).pipe(
        Effect.map((results) => ({ results })),
      ),
  };

  return {
    catalog: catalogPrimitive,
    describe,
    discover,
  };
}

export function buildStaticExecuteDescription(input: {
  tools: readonly ToolDescriptor[];
}): string {
  return [
    "Execute TypeScript in sandbox; call tools directly.",
    "Available tools:",
    ...input.tools.map(formatToolLine),
    "Do not use fetch; use tools.* only.",
  ].join("\n");
}

export function buildDynamicExecuteDescription(input: {
  catalog: ToolCatalog;
}): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const namespaces = yield* input.catalog.listNamespaces({ limit: 200 });

    return [
      "Execute TypeScript in sandbox; call tools via discovery workflow.",
      "Available namespaces:",
      ...namespaces.map((namespace) => `- ${namespace.displayName ?? namespace.namespace}`),
      "Workflow:",
      '1) const { results, bestPath } = await tools.discover({ query: "<intent>", limit: 12 });',
      '2) const path = bestPath ?? results[0]?.path; if (!path) return "No matching tools found.";',
      "3) const details = await tools.describe.tool({ path, includeSchemas: true });",
      "4) Read details.contract?.inputSchema/details.contract?.outputSchema when you need the projected shape.",
      "5) Call selected tools.<path>(input).",
      "The tools object is a lazy proxy, so Object.keys(tools) is not a useful way to discover capabilities.",
      "Do not use fetch; use tools.* only.",
    ].join("\n");
  });
}
