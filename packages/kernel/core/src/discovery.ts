import * as Effect from "effect/Effect";

import { toolDescriptorsFromTools } from "./tool-map";
import type {
  CatalogPrimitive,
  DescribePrimitive,
  DiscoverPrimitive,
  DiscoveryPrimitives,
  SearchHit,
  ToolCatalog,
  ToolCatalogEntry,
  ToolCatalogRole,
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

type SearchHitsWithMode = readonly SearchHit[] & {
  searchMode?: "fts" | "semantic" | "hybrid";
};

type QueryIntent = "task" | "introspection";

type MergedCatalogEntry = {
  catalog: ToolCatalog;
  role: ToolCatalogRole;
};

const withSearchMode = (
  hits: readonly SearchHit[],
  searchMode: "fts" | "semantic" | "hybrid",
): readonly SearchHit[] =>
  Object.assign([...hits], { searchMode }) as readonly SearchHit[];

const classifyQueryIntent = (query: string): QueryIntent => {
  const normalized = query.trim().toLowerCase();

  const introspectionPatterns = [
    /\bavailable tools?\b/,
    /\bwhat tools?\b/,
    /\bfind (?:a )?tool\b/,
    /\bdescribe\b/,
    /\bshow schema\b/,
    /\blist namespaces?\b/,
    /\blist tools?\b/,
    /\bcatalog\b/,
    /\btool search\b/,
  ];

  return introspectionPatterns.some((pattern) => pattern.test(normalized))
    ? "introspection"
    : "task";
};

const roleWeightForIntent = (
  role: ToolCatalogRole,
  intent: QueryIntent,
): number => {
  if (intent === "introspection") {
    switch (role) {
      case "system_helper":
        return 1.6;
      case "local_user":
        return 0.9;
      case "persisted_source":
        return 0.9;
      case "executor":
        return 0.85;
    }
  }

  switch (role) {
    case "local_user":
      return 1.15;
    case "persisted_source":
      return 1.0;
    case "executor":
      return 0.9;
    case "system_helper":
      return 0.55;
  }
};

const mergeSearchModes = (
  groups: ReadonlyArray<SearchHitsWithMode>,
): "fts" | "semantic" | "hybrid" => {
  const modes = new Set(
    groups
      .map((group) => group.searchMode)
      .filter((mode): mode is "fts" | "semantic" | "hybrid" => mode !== undefined),
  );

  if (modes.has("hybrid")) {
    return "hybrid";
  }

  if (modes.has("semantic") && modes.has("fts")) {
    return "hybrid";
  }

  if (modes.has("semantic")) {
    return "semantic";
  }

  return "fts";
};

const fuseSearchHits = (
  groups: ReadonlyArray<{
    hits: SearchHitsWithMode;
    role: ToolCatalogRole;
  }>,
  query: string,
  limit: number,
): readonly SearchHit[] => {
  const k = 60;
  const intent = classifyQueryIntent(query);
  const scores = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let nextOrder = 0;

  for (const group of groups) {
    const roleWeight = roleWeightForIntent(group.role, intent);

    for (let rank = 0; rank < group.hits.length; rank += 1) {
      const hit = group.hits[rank]!;
      scores.set(
        hit.path,
        (scores.get(hit.path) ?? 0) + (roleWeight / (k + rank + 1)),
      );
      if (!firstSeen.has(hit.path)) {
        firstSeen.set(hit.path, nextOrder);
      }
      nextOrder += 1;
    }
  }

  const fusedHits = [...scores.entries()]
    .sort((left, right) =>
      right[1] - left[1]
      || (firstSeen.get(left[0]) ?? Number.MAX_SAFE_INTEGER)
        - (firstSeen.get(right[0]) ?? Number.MAX_SAFE_INTEGER)
      || left[0].localeCompare(right[0]),
    )
    .slice(0, limit)
    .map(([path, score]) => ({
      path: path as ToolPath,
      score,
    }));

  return withSearchMode(fusedHits, mergeSearchModes(groups.map((group) => group.hits)));
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
    searchTools: ({ query, namespace, sourceKey, limit }) => {
      const queryTokens = tokenize(query);

      return Effect.succeed(
        entries
          .filter((entry) =>
            (!namespace || namespaceFromCatalogEntry(entry) === namespace)
            && (!sourceKey || entry.descriptor.sourceKey === sourceKey),
          )
          .map((entry) => ({
            path: entry.descriptor.path,
            score: scoreCatalogEntry(queryTokens, entry),
          }))
          .filter((hit) => hit.score > 0)
          .sort((left, right) => right.score - left.score)
          .slice(0, limit),
      );
    },
  } satisfies ToolCatalog;
}

export function mergeToolCatalogs(input: {
  catalogs: ReadonlyArray<ToolCatalog | MergedCatalogEntry>;
}): ToolCatalog {
  const catalogs = input.catalogs.map((catalog): MergedCatalogEntry =>
    "catalog" in catalog
      ? catalog
      : {
          catalog,
          role: "persisted_source",
        },
  );

  return {
    listNamespaces: ({ limit }) =>
      Effect.gen(function* () {
        const groups = yield* Effect.forEach(
          catalogs,
          ({ catalog }) => catalog.listNamespaces({ limit: Math.max(limit, limit * catalogs.length) }),
          { concurrency: "unbounded" },
        );

        return mergeToolNamespaces(groups).slice(0, limit);
      }),

    listTools: ({ namespace, query, limit, includeSchemas = false }) =>
      Effect.gen(function* () {
        const groups = yield* Effect.forEach(
          catalogs,
          ({ catalog }) =>
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
        for (const { catalog } of catalogs) {
          const descriptor = yield* catalog.getToolByPath({ path, includeSchemas });
          if (descriptor) {
            return descriptor;
          }
        }

        return null;
      }),

    searchTools: ({ query, namespace, sourceKey, limit }) =>
      Effect.gen(function* () {
        const groups = yield* Effect.forEach(
          catalogs,
          ({ catalog, role }) =>
            catalog.searchTools({
              query,
              ...(namespace !== undefined ? { namespace } : {}),
              ...(sourceKey !== undefined ? { sourceKey } : {}),
              limit: Math.max(limit, limit * catalogs.length),
            }).pipe(
              Effect.map((hits) => ({
                hits: hits as SearchHitsWithMode,
                role,
              })),
            ),
          { concurrency: "unbounded" },
        );

        return fuseSearchHits(groups, query, limit);
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
    sourceKey,
    limit = 12,
    includeSchemas = false,
  }) =>
    Effect.gen(function* () {
      const hits = yield* catalog.searchTools({
        query,
        ...(sourceKey !== undefined ? { sourceKey } : {}),
        limit,
      });

      if (hits.length === 0) {
        return {
          bestPath: null,
          results: [],
          total: 0,
        };
      }

      const descriptors = yield* Effect.forEach(
        hits,
        (hit) =>
          catalog.getToolByPath({
            path: hit.path,
            includeSchemas,
          }),
        { concurrency: "unbounded" },
      );

      const hydrated = hits
        .map((hit, index) => {
          const descriptor = descriptors[index];
          if (!descriptor) {
            return null;
          }

          return {
            path: descriptor.path,
            score: hit.score,
            description: descriptor.description,
            interaction: descriptor.interaction ?? "auto",
            ...(descriptorContract(descriptor, includeSchemas)
              ? { contract: descriptorContract(descriptor, includeSchemas) }
              : {}),
          };
        })
        .filter(Boolean) as Array<
        Record<string, unknown> & { path: ToolPath; score: number }
      >;

      return {
        bestPath: hydrated[0]?.path ?? null,
        results: hydrated,
        total: hydrated.length,
      };
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
      '1) const matches = await tools.discover({ query: "<intent>", limit: 12 });',
      "2) const details = await tools.describe.tool({ path, includeSchemas: true });",
      "3) Read details.contract?.inputSchema/details.contract?.outputSchema when you need the projected shape.",
      "4) Call selected tools.<path>(input).",
      "Do not use fetch; use tools.* only.",
    ].join("\n");
  });
}
