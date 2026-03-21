import * as Effect from "effect/Effect";
import type {
  ToolCatalog,
  ToolDescriptor,
  ToolPath,
  SearchHit,
} from "@executor/codemode-core";

/**
 * Input schema for the tool_search MCP tool.
 */
export interface ToolSearchInput {
  /** Natural language query, or "+path" for exact lookup */
  query: string;
  /** Maximum results to return (default 10) */
  max_results?: number;
  /** Filter by source key */
  source?: string;
  /** Include input/output schemas in results */
  include_schemas?: boolean;
}

/**
 * A single result item from tool_search.
 */
export interface ToolSearchResultItem {
  path: string;
  score: number;
  description?: string;
  input_type_preview?: string;
  output_type_preview?: string;
  input_schema?: unknown;
  output_schema?: unknown;
}

/**
 * Output for the tool_search MCP tool.
 */
export interface ToolSearchOutput {
  results: ToolSearchResultItem[];
  meta: {
    query: string;
    mode: "exact" | "search";
    total: number;
    search_mode: "fts" | "semantic" | "hybrid";
  };
}

/**
 * Parse query to determine mode.
 * "+github.issues.create" → exact lookup
 * "create github issue" → semantic/FTS search
 */
function parseQuery(query: string): { mode: "exact" | "search"; cleanQuery: string } {
  if (query.startsWith("+")) {
    return { mode: "exact", cleanQuery: query.slice(1) };
  }
  return { mode: "search", cleanQuery: query };
}

/**
 * Map a ToolDescriptor to a result item.
 */
function descriptorToResult(
  path: string,
  score: number,
  tool: ToolDescriptor | null,
  includeSchemas: boolean,
): ToolSearchResultItem {
  return {
    path,
    score,
    description: tool?.description,
    input_type_preview: tool?.contract?.inputTypePreview,
    output_type_preview: tool?.contract?.outputTypePreview,
    ...(includeSchemas ? {
      input_schema: tool?.contract?.inputSchema,
      output_schema: tool?.contract?.outputSchema,
    } : {}),
  };
}

/**
 * Handle a tool_search request using the workspace ToolCatalog.
 */
export function handleToolSearch(
  catalog: ToolCatalog,
  input: ToolSearchInput,
): Effect.Effect<ToolSearchOutput, unknown> {
  return Effect.gen(function* () {
    const maxResults = input.max_results ?? 10;
    const includeSchemas = input.include_schemas ?? false;
    const { mode, cleanQuery } = parseQuery(input.query);

    if (mode === "exact") {
      const tool: ToolDescriptor | null = yield* catalog.getToolByPath({
        path: cleanQuery as ToolPath,
        includeSchemas,
      });

      if (!tool) {
        return {
          results: [] as ToolSearchResultItem[],
          meta: { query: input.query, mode: "exact" as const, total: 0, search_mode: "fts" as const },
        };
      }

      return {
        results: [descriptorToResult(tool.path, 1.0, tool, includeSchemas)],
        meta: { query: input.query, mode: "exact" as const, total: 1, search_mode: "fts" as const },
      };
    }

    // Search mode
    const hits: readonly SearchHit[] = yield* catalog.searchTools({
      query: cleanQuery,
      limit: maxResults,
    });

    // Hydrate results with descriptors
    const results: ToolSearchResultItem[] = [];
    for (const hit of hits) {
      const tool: ToolDescriptor | null = yield* catalog.getToolByPath({
        path: hit.path,
        includeSchemas,
      });
      results.push(descriptorToResult(hit.path, hit.score, tool, includeSchemas));
    }

    return {
      results,
      meta: {
        query: input.query,
        mode: "search" as const,
        total: results.length,
        search_mode: "fts" as const,
      },
    };
  });
}
