import type {
  SearchResult,
  Source,
} from "#schema";

import {
  buildSearchResult,
  type ExecutorSearchProvider,
  type SearchDocument,
  type SearchProviderStatus,
  type SearchProviderSyncPayload,
  type SearchSourceRequest,
  type SearchWorkspaceRequest,
} from "./types";
import {
  searchResultItemFromDocument,
} from "./documents";

const tokenize = (value: string): string[] =>
  value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const LOW_SIGNAL_QUERY_TOKENS = new Set([
  "a",
  "an",
  "the",
  "am",
  "as",
  "for",
  "from",
  "get",
  "i",
  "in",
  "is",
  "list",
  "me",
  "my",
  "of",
  "on",
  "or",
  "signed",
  "to",
  "who",
]);

const singularizeToken = (value: string): string =>
  value.length > 3 && value.endsWith("s") ? value.slice(0, -1) : value;

const tokenEquals = (left: string, right: string): boolean =>
  left === right || singularizeToken(left) === singularizeToken(right);

const hasTokenMatch = (
  tokens: readonly string[],
  queryToken: string,
): boolean => tokens.some((token) => tokenEquals(token, queryToken));

const hasSubstringMatch = (value: string, queryToken: string): boolean => {
  if (value.includes(queryToken)) {
    return true;
  }

  const singular = singularizeToken(queryToken);
  return singular !== queryToken && value.includes(singular);
};

const queryTokenWeight = (token: string): number =>
  LOW_SIGNAL_QUERY_TOKENS.has(token) ? 0.25 : 1;

const workspaceScore = (
  queryTokens: readonly string[],
  document: SearchDocument,
): number => {
  const pathText = document.path.toLowerCase();
  const namespaceText = document.namespace.toLowerCase();
  const toolIdText = document.path.split(".").at(-1)?.toLowerCase() ?? "";
  const titleText = document.title?.toLowerCase() ?? "";
  const descriptionText = document.description?.toLowerCase() ?? "";
  const templateText = [
    document.pathTemplate,
    document.operationId,
    document.leaf,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ")
    .toLowerCase();

  const pathTokens = tokenize(`${document.path} ${toolIdText}`);
  const namespaceTokens = tokenize(document.namespace);
  const titleTokens = tokenize(document.title ?? "");
  const templateTokens = tokenize(templateText);

  let score = 0;
  let structuralHits = 0;
  let namespaceHits = 0;
  let pathHits = 0;

  for (const token of queryTokens) {
    const weight = queryTokenWeight(token);

    if (hasTokenMatch(pathTokens, token)) {
      score += 12 * weight;
      structuralHits += 1;
      pathHits += 1;
      continue;
    }

    if (hasTokenMatch(namespaceTokens, token)) {
      score += 11 * weight;
      structuralHits += 1;
      namespaceHits += 1;
      continue;
    }

    if (hasTokenMatch(titleTokens, token)) {
      score += 9 * weight;
      structuralHits += 1;
      continue;
    }

    if (hasTokenMatch(templateTokens, token)) {
      score += 8 * weight;
      structuralHits += 1;
      continue;
    }

    if (hasSubstringMatch(pathText, token) || hasSubstringMatch(toolIdText, token)) {
      score += 6 * weight;
      structuralHits += 1;
      pathHits += 1;
      continue;
    }

    if (hasSubstringMatch(namespaceText, token)) {
      score += 5 * weight;
      structuralHits += 1;
      namespaceHits += 1;
      continue;
    }

    if (hasSubstringMatch(titleText, token) || hasSubstringMatch(templateText, token)) {
      score += 4 * weight;
      structuralHits += 1;
      continue;
    }

    if (hasSubstringMatch(descriptionText, token)) {
      score += 0.5 * weight;
    }
  }

  const strongTokens = queryTokens.filter((token) => queryTokenWeight(token) >= 1);
  if (strongTokens.length >= 2) {
    for (let index = 0; index < strongTokens.length - 1; index += 1) {
      const current = strongTokens[index]!;
      const next = strongTokens[index + 1]!;
      const phrases = [
        `${current}-${next}`,
        `${current}.${next}`,
        `${current}/${next}`,
      ];

      if (phrases.some((phrase) => pathText.includes(phrase) || templateText.includes(phrase))) {
        score += 10;
      }
    }
  }

  if (namespaceHits > 0 && pathHits > 0) {
    score += 8;
  }

  if (structuralHits === 0 && score > 0) {
    score *= 0.25;
  }

  return score;
};

const sourceScore = (
  queryTokens: readonly string[],
  document: SearchDocument,
): { score: number; metadata?: Record<string, unknown> } | null => {
  let score = 0;
  const reasons: string[] = [];
  const pathTokens = tokenize(document.path);
  const titleTokens = tokenize(document.title ?? "");
  const descriptionTokens = tokenize(document.description ?? "");
  const tagTokens = document.tags.flatMap(tokenize);
  const methodPathTokens = tokenize(
    `${document.method ?? ""} ${document.pathTemplate ?? ""}`,
  );

  for (const token of queryTokens) {
    if (pathTokens.includes(token)) {
      score += 12;
      reasons.push(`path matches ${token} (+12)`);
      continue;
    }
    if (tagTokens.includes(token)) {
      score += 10;
      reasons.push(`tag matches ${token} (+10)`);
      continue;
    }
    if (titleTokens.includes(token)) {
      score += 8;
      reasons.push(`title matches ${token} (+8)`);
      continue;
    }
    if (methodPathTokens.includes(token)) {
      score += 6;
      reasons.push(`method/path matches ${token} (+6)`);
      continue;
    }
    if (descriptionTokens.includes(token) || document.searchText.includes(token)) {
      score += 2;
      reasons.push(`description/text matches ${token} (+2)`);
    }
  }

  if (score <= 0) {
    return null;
  }

  return {
    score,
    metadata: reasons.length > 0 ? { reasons } : undefined,
  };
};

const providerInfo = (fallbackUsed = false) => ({
  providerKey: "lexical",
  mode: "lexical",
  backend: "in-memory",
  ...(fallbackUsed ? { fallbackUsed: true } : {}),
});

export const createLexicalSearchProvider = (): ExecutorSearchProvider => {
  const bySource = new Map<Source["id"], {
    revisionId: string;
    sourceHash: string | null;
    generatedAt: number;
    documents: readonly SearchDocument[];
  }>();

  const upsertSource = (input: SearchProviderSyncPayload) => {
    const existing = bySource.get(input.source.id);
    if (
      existing &&
      existing.revisionId === input.revisionId &&
      existing.sourceHash === input.sourceHash
    ) {
      return;
    }

    bySource.set(input.source.id, {
      revisionId: input.revisionId,
      sourceHash: input.sourceHash,
      generatedAt: input.generatedAt,
      documents: input.documents,
    });
  };

  const allDocuments = () => [...bySource.values()].flatMap((entry) => entry.documents);

  const runWorkspaceSearch = (input: SearchWorkspaceRequest): SearchResult => {
    const queryTokens = tokenize(input.query);
    const results = allDocuments()
      .filter((document) => !input.namespace || document.namespace === input.namespace)
      .map((document) => ({
        document,
        score: workspaceScore(queryTokens, document),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) =>
        right.score - left.score || left.document.path.localeCompare(right.document.path),
      )
      .slice(0, input.limit)
      .map(({ document, score }) =>
        searchResultItemFromDocument({
          document,
          score,
          includeSchemas: input.includeSchemas,
        }),
      );

    return buildSearchResult({
      provider: providerInfo(),
      results,
    });
  };

  const runSourceSearch = (input: SearchSourceRequest): SearchResult => {
    const queryTokens = tokenize(input.query);
    const sourceDocuments = bySource.get(input.sourceId)?.documents ?? [];
    const results = sourceDocuments
      .map((document) => {
        const ranked = sourceScore(queryTokens, document);
        return ranked ? { document, ...ranked } : null;
      })
      .filter((item): item is { document: SearchDocument; score: number; metadata?: Record<string, unknown> } =>
        item !== null,
      )
      .sort((left, right) =>
        right.score - left.score || left.document.path.localeCompare(right.document.path),
      )
      .slice(0, input.limit)
      .map(({ document, score, metadata }) =>
        searchResultItemFromDocument({
          document,
          score,
          includeSchemas: input.includeSchemas,
          metadata,
        }),
      );

    return buildSearchResult({
      provider: providerInfo(),
      results,
    });
  };

  return {
    key: "lexical",
    searchWorkspace: runWorkspaceSearch,
    discoverSource: runSourceSearch,
    syncSourceCatalog: upsertSource,
    removeSource: ({ sourceId }) => {
      bySource.delete(sourceId);
    },
    status: (): SearchProviderStatus => ({
      ...providerInfo(),
      configuredProviderKey: "lexical",
      healthy: true,
      sourceCount: bySource.size,
      documentCount: allDocuments().length,
      staleSourceCount: 0,
    }),
    refresh: (): SearchProviderStatus => ({
      ...providerInfo(),
      configuredProviderKey: "lexical",
      healthy: true,
      sourceCount: bySource.size,
      documentCount: allDocuments().length,
      staleSourceCount: 0,
    }),
    rebuild: (): SearchProviderStatus => ({
      ...providerInfo(),
      configuredProviderKey: "lexical",
      healthy: true,
      sourceCount: bySource.size,
      documentCount: allDocuments().length,
      staleSourceCount: 0,
    }),
  };
};

export const markSearchResultFallback = (result: SearchResult): SearchResult => ({
  ...result,
  provider: {
    ...result.provider,
    fallbackUsed: true,
  },
});
