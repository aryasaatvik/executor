import type {
  SearchProviderInfo,
  SearchResult,
  SearchResultItem,
  Source,
} from "#schema";
import type {
  ToolContract,
} from "@executor/codemode-core";
import type * as Schema from "effect/Schema";

export type SearchDocument = {
  path: string;
  sourceId: Source["id"];
  sourceKey: string;
  namespace: string;
  searchText: string;
  title: string | null;
  description: string | null;
  interaction: "auto" | "required";
  protocol: string | null;
  method: string | null;
  pathTemplate: string | null;
  rawToolId: string | null;
  operationId: string | null;
  group: string | null;
  leaf: string | null;
  tags: readonly string[];
  inputTypePreview: string | null;
  outputTypePreview: string | null;
  contract: ToolContract | null;
  metadata: Record<string, unknown>;
};

export type SearchProviderSyncPayload = {
  source: Source;
  providerKey: string;
  revisionId: string;
  sourceHash: string | null;
  generatedAt: number;
  documents: readonly SearchDocument[];
};

export type SearchWorkspaceRequest = {
  query: string;
  namespace?: string;
  limit: number;
  includeSchemas: boolean;
};

export type SearchSourceRequest = {
  sourceId: Source["id"];
  query: string;
  limit: number;
  includeSchemas: boolean;
};

export type SearchProviderStatus = SearchProviderInfo & {
  configuredProviderKey: string;
  healthy: boolean;
  detail?: string;
  sourceCount?: number;
  documentCount?: number;
  staleSourceCount?: number;
};

export type SearchProviderStorage = {
  rootDirectory: string | null;
  resolvePath: (name: string) => string | null;
  resolveSqlitePath: (name: string) => string | null;
};

export type ExecutorSearchProviderContext<TConfig = unknown> = {
  config: TConfig;
  storage: SearchProviderStorage;
};

export type ExecutorSearchProvider<TConfig = unknown> = {
  key: string;
  init?: () => Promise<void> | void;
  searchWorkspace: (
    input: SearchWorkspaceRequest,
  ) => Promise<SearchResult> | SearchResult;
  discoverSource: (
    input: SearchSourceRequest,
  ) => Promise<SearchResult> | SearchResult;
  syncSourceCatalog: (
    input: SearchProviderSyncPayload,
  ) => Promise<void> | void;
  removeSource: (input: {
    sourceId: Source["id"];
    reason: "removed" | "disabled" | "not_connected";
  }) => Promise<void> | void;
  status: () => Promise<SearchProviderStatus> | SearchProviderStatus;
  refresh: () => Promise<SearchProviderStatus> | SearchProviderStatus;
  rebuild: () => Promise<SearchProviderStatus> | SearchProviderStatus;
};

export type ExecutorSearchProviderDefinition<TConfig = unknown> = {
  providerKey: string;
  displayName: string;
  configSchema: Schema.Schema<TConfig, any, never>;
  create: (
    input: ExecutorSearchProviderContext<TConfig>,
  ) => ExecutorSearchProvider<TConfig>;
};

export const buildSearchResult = (input: {
  provider: SearchProviderInfo;
  results: readonly SearchResultItem[];
}): SearchResult => ({
  provider: input.provider,
  bestPath: input.results[0]?.path ?? null,
  total: input.results.length,
  results: input.results,
});
