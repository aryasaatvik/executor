import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  and,
  asc,
  desc,
  eq,
  inArray,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import type {
  SearchResult,
  SearchResultItem,
} from "@executor/platform-sdk/schema";
import {
  buildSearchResult,
  type ExecutorSearchProvider,
  type SearchDocument,
  type SearchDocumentLike as RuntimeSearchDocumentLike,
  type SearchProviderStatus,
  type SearchProviderSyncPayload,
  type SearchSourceRequest,
  type SearchWorkspaceRequest,
} from "@executor/platform-sdk/runtime";

import {
  createHashEmbedder,
  createScoreFusionReranker,
  createSqliteVecBackend,
} from "./semantic";
import {
  SEARCH_DOCUMENTS_TABLE,
  SEARCH_FTS_TABLE,
  SEARCH_SOURCES_TABLE,
  SEARCH_VECTORS_TABLE,
  searchDocuments,
  searchSources,
  type InsertSearchDocumentRow,
  type InsertSearchSourceStateRow,
  type SearchDocumentRow,
  type SearchSourceStateRow,
} from "./schema";
import {
  SQLITE_SEARCH_BACKEND,
  SQLITE_SEARCH_DEFAULT_DB_NAME,
  SQLITE_SEARCH_HYBRID_BACKEND,
  SQLITE_SEARCH_PROVIDER_KEY,
  type CreateSqliteSearchProviderInput,
} from "./shared";

type SearchDocMatch = {
  document: SearchDocument;
  score: number;
  metadata?: Record<string, unknown>;
};

type SearchDatabaseBundle = ReturnType<typeof openSqliteDatabase>;

type HybridCandidate = SearchDocMatch & {
  lexicalScore: number;
  ftsRank?: number;
  ftsScore?: number;
  ftsRawRank?: number;
  vectorRank?: number;
  vectorScore?: number;
  vectorDistance?: number;
};

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("./migration", import.meta.url));

const trimOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const safeJsonParse = <T>(value: string | null, fallback: T): T => {
  if (value === null) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const tokenize = (value: string): string[] =>
  value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const buildFtsQuery = (query: string): string | null => {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return null;
  }

  return tokens.map((token) => `${token}*`).join(" AND ");
};

const normalizePath = (input: {
  storageRootDirectory: string | null;
  resolveSqlitePath: (name: string) => string | null;
  databasePath?: string;
}): string => {
  const configured = trimOrNull(input.databasePath);
  if (configured !== null) {
    return isAbsolute(configured) || input.storageRootDirectory === null
      ? configured
      : join(input.storageRootDirectory, configured);
  }

  const resolved = input.resolveSqlitePath(SQLITE_SEARCH_DEFAULT_DB_NAME);
  if (resolved !== null) {
    return resolved;
  }

  return join(
    input.storageRootDirectory ?? ".",
    `${SQLITE_SEARCH_DEFAULT_DB_NAME}.sqlite`,
  );
};

const openSqliteDatabase = (databasePath: string) => {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const sqlite = new Database(databasePath, { create: true, strict: true });
  sqlite.exec("PRAGMA foreign_keys = ON;");

  const db = drizzle({
    client: sqlite,
    schema: {
      searchDocuments,
      searchSources,
    },
  });

  if (existsSync(MIGRATIONS_DIRECTORY)) {
    migrate(db, {
      migrationsFolder: MIGRATIONS_DIRECTORY,
    });
  }

  return { sqlite, db };
};

const contractPreview = (
  contract: NonNullable<SearchDocument["contract"]>,
): NonNullable<SearchDocument["contract"]> => ({
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
});

const searchResultItemFromDocument = (input: {
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
          : contractPreview(input.document.contract),
      }
    : {}),
  metadata: {
    ...input.document.metadata,
    ...(input.metadata ?? {}),
  },
});

const documentFromRow = (row: SearchDocumentRow): SearchDocument => ({
  path: row.path,
  sourceId: row.source_id as SearchDocument["sourceId"],
  sourceKey: row.source_id,
  namespace: row.namespace,
  searchText: row.search_text,
  title: row.title,
  description: row.description,
  interaction: row.interaction,
  protocol: row.protocol,
  method: row.method,
  pathTemplate: row.path_template,
  rawToolId: row.raw_tool_id,
  operationId: row.operation_id,
  group: row.tool_group,
  leaf: row.leaf,
  tags: safeJsonParse<readonly string[]>(row.tags_json, []),
  inputTypePreview: row.input_type_preview,
  outputTypePreview: row.output_type_preview,
  contract: safeJsonParse<SearchDocument["contract"]>(row.contract_json, null),
  metadata: toRecord(
    safeJsonParse<Record<string, unknown>>(row.metadata_json, {}),
  ),
});

const lexicalScore = (
  queryTokens: readonly string[],
  document: SearchDocument,
): number => {
  const pathText = document.path.toLowerCase();
  const namespaceText = document.namespace.toLowerCase();
  const titleText = document.title?.toLowerCase() ?? "";
  const descriptionText = document.description?.toLowerCase() ?? "";
  const searchText = document.searchText.toLowerCase();
  const tagTokens = document.tags.flatMap(tokenize);
  const pathTokens = tokenize(document.path);
  const namespaceTokens = tokenize(document.namespace);
  const titleTokens = tokenize(document.title ?? "");
  const descriptionTokens = tokenize(document.description ?? "");
  let score = 0;

  for (const token of queryTokens) {
    if (pathTokens.includes(token) || pathText.includes(token)) {
      score += 12;
      continue;
    }

    if (namespaceTokens.includes(token) || namespaceText.includes(token)) {
      score += 10;
      continue;
    }

    if (titleTokens.includes(token) || titleText.includes(token)) {
      score += 8;
      continue;
    }

    if (tagTokens.includes(token)) {
      score += 6;
      continue;
    }

    if (descriptionTokens.includes(token) || descriptionText.includes(token)) {
      score += 4;
      continue;
    }

    if (searchText.includes(token)) {
      score += 2;
    }
  }

  return score;
};

const providerInfo = (mode: "fts" | "hybrid") => ({
  providerKey: SQLITE_SEARCH_PROVIDER_KEY,
  mode,
  backend: mode === "hybrid"
    ? SQLITE_SEARCH_HYBRID_BACKEND
    : SQLITE_SEARCH_BACKEND,
});

export const createSqliteSearchProvider = (
  input: CreateSqliteSearchProviderInput,
): ExecutorSearchProvider => {
  const mode = input.config.mode ?? "fts";
  const embedder = createHashEmbedder({
    dimensions: input.config.embedder?.dimensions,
  });
  const reranker = createScoreFusionReranker();
  const ranking = {
    ftsWeight: input.config.ranking?.ftsWeight ?? 1,
    vectorWeight: input.config.ranking?.vectorWeight ?? 1,
    rrfK: Math.max(1, Math.floor(input.config.ranking?.rrfK ?? 60)),
  };
  const maxCandidates = Math.max(
    12,
    Math.floor(input.config.vector?.maxCandidates ?? 36),
  );
  const databasePath = normalizePath({
    storageRootDirectory: input.storage.rootDirectory,
    resolveSqlitePath: input.storage.resolveSqlitePath,
    databasePath: input.config.databasePath,
  });
  let database: SearchDatabaseBundle | null = null;

  const ensureDatabase = () => {
    if (database !== null) {
      return database;
    }

    database = openSqliteDatabase(databasePath);
    return database;
  };

  const vectorBackend = mode === "hybrid"
    ? createSqliteVecBackend({
        db: () => ensureDatabase().sqlite,
        tableName: SEARCH_VECTORS_TABLE,
        dimensions: embedder.dimensions,
        extensionPath: input.config.vector?.extensionPath,
      })
    : null;
  const currentVectorBackendKey = vectorBackend?.key ?? null;
  const currentEmbedderKey = mode === "hybrid" ? embedder.key : null;

  const queryAll = <TRow>(statement: string, params: readonly unknown[] = []) =>
    ensureDatabase().sqlite.prepare(statement).all(...(params as any[])) as TRow[];

  const activeProviderInfo = () =>
    providerInfo(
      mode === "hybrid" && vectorBackend?.isAvailable() !== true ? "hybrid" : mode,
    );

  const fetchSourceState = (sourceId: string) =>
    ensureDatabase().db
      .select()
      .from(searchSources)
      .where(eq(searchSources.source_id, sourceId))
      .get();

  const fetchSourceDocumentIds = (sourceId: string): string[] =>
    ensureDatabase().db
      .select({ path: searchDocuments.path })
      .from(searchDocuments)
      .where(eq(searchDocuments.source_id, sourceId))
      .orderBy(asc(searchDocuments.path))
      .all()
      .map((row) => row.path);

  const fetchIndexedSourceIds = (): string[] =>
    ensureDatabase().db
      .select({ sourceId: searchSources.source_id })
      .from(searchSources)
      .orderBy(asc(searchSources.source_id))
      .all()
      .map((row) => row.sourceId);

  const ensureHybridVectorBackend = async () => {
    if (mode !== "hybrid" || vectorBackend === null) {
      return;
    }
    await vectorBackend.init();
  };

  const staleHybridSourceWhere = `
    vector_error IS NOT NULL
    OR COALESCE(vector_document_count, -1) != document_count
    OR vector_backend IS NULL
    OR vector_backend != ?
    OR embedder_key IS NULL
    OR embedder_key != ?
  `;

  const fetchStaleHybridSourceIds = (): string[] => {
    if (mode !== "hybrid") {
      return [];
    }

    if (vectorBackend?.isRebuildRequired() === true) {
      return fetchIndexedSourceIds();
    }

    return queryAll<{ source_id: string }>(
      `
        SELECT source_id
        FROM ${SEARCH_SOURCES_TABLE}
        WHERE ${staleHybridSourceWhere}
        ORDER BY source_id ASC
      `,
      [currentVectorBackendKey, currentEmbedderKey],
    ).map((row) => row.source_id);
  };

  const updateSourceVectorState = (nextState: {
    sourceId: string;
    vectorDocumentCount: number | null;
    vectorError: string | null;
  }) => {
    ensureDatabase().db
      .update(searchSources)
      .set({
        vector_document_count: nextState.vectorDocumentCount,
        vector_error: nextState.vectorError,
        vector_backend: currentVectorBackendKey,
        embedder_key: embedder.key,
        embedded_at: nextState.vectorError === null ? Date.now() : null,
      })
      .where(eq(searchSources.source_id, nextState.sourceId))
      .run();
  };

  const deleteSourceRows = (sourceId: string) => {
    const currentIds = fetchSourceDocumentIds(sourceId);
    if (vectorBackend?.isAvailable() === true && currentIds.length > 0) {
      vectorBackend.removeByIds(currentIds);
    }

    ensureDatabase().db.transaction((tx) => {
      tx.delete(searchDocuments)
        .where(eq(searchDocuments.source_id, sourceId))
        .run();
      tx.delete(searchSources)
        .where(eq(searchSources.source_id, sourceId))
        .run();
    });
  };

  const syncVectorsForSource = (vectorSync: {
    sourceId: string;
    removedIds: readonly string[];
    documents: readonly SearchDocument[];
  }) => {
    if (mode !== "hybrid") {
      return;
    }

    if (vectorBackend === null || vectorBackend.isAvailable() !== true) {
      updateSourceVectorState({
        sourceId: vectorSync.sourceId,
        vectorDocumentCount: null,
        vectorError: vectorBackend?.detail() ?? "sqlite-vec is unavailable",
      });
      return;
    }

    try {
      if (vectorSync.removedIds.length > 0) {
        vectorBackend.removeByIds(vectorSync.removedIds);
      }

      vectorBackend.upsert(
        vectorSync.documents.map((document) => ({
          id: document.path,
          embedding: embedder.embedDocument(document as RuntimeSearchDocumentLike),
        })),
      );

      updateSourceVectorState({
        sourceId: vectorSync.sourceId,
        vectorDocumentCount: vectorSync.documents.length,
        vectorError: null,
      });
    } catch (cause) {
      updateSourceVectorState({
        sourceId: vectorSync.sourceId,
        vectorDocumentCount: null,
        vectorError: toError(cause).message,
      });
    }
  };

  const toInsertDocument = (
    payload: SearchProviderSyncPayload,
    document: SearchDocument,
  ): InsertSearchDocumentRow => ({
    source_id: payload.source.id,
    source_kind: payload.source.kind,
    provider_key: payload.providerKey,
    revision_id: payload.revisionId,
    source_hash: payload.sourceHash,
    generated_at: payload.generatedAt,
    path: document.path,
    namespace: document.namespace,
    search_text: document.searchText,
    title: document.title,
    description: document.description,
    interaction: document.interaction,
    protocol: document.protocol,
    method: document.method,
    path_template: document.pathTemplate,
    raw_tool_id: document.rawToolId,
    operation_id: document.operationId,
    tool_group: document.group,
    leaf: document.leaf,
    tags_json: JSON.stringify(document.tags),
    input_type_preview: document.inputTypePreview,
    output_type_preview: document.outputTypePreview,
    contract_json: document.contract === null ? null : JSON.stringify(document.contract),
    metadata_json: JSON.stringify(document.metadata),
  });

  const toSourceStateInsert = (
    payload: SearchProviderSyncPayload,
  ): InsertSearchSourceStateRow => ({
    source_id: payload.source.id,
    source_kind: payload.source.kind,
    provider_key: payload.providerKey,
    revision_id: payload.revisionId,
    source_hash: payload.sourceHash,
    generated_at: payload.generatedAt,
    document_count: payload.documents.length,
    vector_document_count: mode === "hybrid" ? null : payload.documents.length,
    vector_error: null,
    vector_backend: currentVectorBackendKey,
    embedder_key: currentEmbedderKey,
    embedded_at: mode === "hybrid" ? null : Date.now(),
    updated_at: Date.now(),
  });

  const upsertDocuments = (payload: SearchProviderSyncPayload) => {
    const existing = fetchSourceState(payload.source.id);
    const existingIds = fetchSourceDocumentIds(payload.source.id);
    const documentIds = payload.documents.map((document) => document.path);
    const needsDocumentRewrite =
      existing === undefined
      || existing.revision_id !== payload.revisionId
      || existing.source_hash !== payload.sourceHash;
    const needsVectorReindex =
      mode === "hybrid" && (
        existing === undefined
        || existing.vector_error !== null
        || existing.vector_document_count !== payload.documents.length
        || existing.vector_backend !== currentVectorBackendKey
        || existing.embedder_key !== embedder.key
      );

    if (!needsDocumentRewrite && !needsVectorReindex) {
      return;
    }

    if (needsDocumentRewrite) {
      const nextSourceState = toSourceStateInsert(payload);
      const nextDocuments = payload.documents.map((document) =>
        toInsertDocument(payload, document));

      ensureDatabase().db.transaction((tx) => {
        tx.delete(searchDocuments)
          .where(eq(searchDocuments.source_id, payload.source.id))
          .run();
        tx.delete(searchSources)
          .where(eq(searchSources.source_id, payload.source.id))
          .run();

        if (nextDocuments.length > 0) {
          tx.insert(searchDocuments)
            .values(nextDocuments)
            .run();
        }

        tx.insert(searchSources)
          .values(nextSourceState)
          .onConflictDoUpdate({
            target: searchSources.source_id,
            set: nextSourceState,
          })
          .run();
      });
    }

    if (needsVectorReindex || needsDocumentRewrite) {
      syncVectorsForSource({
        sourceId: payload.source.id,
        removedIds: existingIds.filter((id) => !documentIds.includes(id)),
        documents: payload.documents,
      });
    }
  };

  const fetchWorkspaceDocs = (request: SearchWorkspaceRequest) => {
    const filters = [];
    const namespace = trimOrNull(request.namespace);

    if (namespace !== null) {
      filters.push(eq(searchDocuments.namespace, namespace));
    }

    return ensureDatabase().db
      .select()
      .from(searchDocuments)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(searchDocuments.generated_at), asc(searchDocuments.path))
      .all();
  };

  const fetchSourceDocs = (sourceId: string) =>
    ensureDatabase().db
      .select()
      .from(searchDocuments)
      .where(eq(searchDocuments.source_id, sourceId))
      .orderBy(desc(searchDocuments.generated_at), asc(searchDocuments.path))
      .all();

  const fetchRowsByPaths = (inputRows: {
    paths: readonly string[];
    sourceId?: string;
    namespace?: string;
  }): SearchDocumentRow[] => {
    if (inputRows.paths.length === 0) {
      return [];
    }

    const filters = [inArray(searchDocuments.path, [...inputRows.paths])];
    const namespace = trimOrNull(inputRows.namespace);

    if (inputRows.sourceId !== undefined) {
      filters.push(eq(searchDocuments.source_id, inputRows.sourceId));
    }

    if (namespace !== null) {
      filters.push(eq(searchDocuments.namespace, namespace));
    }

    const rows = ensureDatabase().db
      .select()
      .from(searchDocuments)
      .where(and(...filters))
      .all();
    const byPath = new Map(rows.map((row) => [row.path, row]));

    return inputRows.paths
      .map((path) => byPath.get(path))
      .filter((row): row is SearchDocumentRow => row !== undefined);
  };

  const rebuildVectors = (sourceIds?: readonly string[]) => {
    if (mode !== "hybrid" || vectorBackend === null) {
      return;
    }

    if (vectorBackend.isAvailable() !== true) {
      for (const state of ensureDatabase().db.select().from(searchSources).all()) {
        if (!sourceIds || sourceIds.includes(state.source_id)) {
          updateSourceVectorState({
            sourceId: state.source_id,
            vectorDocumentCount: null,
            vectorError: vectorBackend.detail() ?? "sqlite-vec is unavailable",
          });
        }
      }
      return;
    }

    const states = ensureDatabase().db
      .select()
      .from(searchSources)
      .orderBy(asc(searchSources.source_id))
      .all()
      .filter((state) => !sourceIds || sourceIds.includes(state.source_id));
    const documentsBySource = states.map((state) => ({
      sourceId: state.source_id,
      rows: fetchSourceDocs(state.source_id),
    }));

    const records = documentsBySource.flatMap((entry) =>
      entry.rows.map((row) => ({
        id: row.path,
        embedding: embedder.embedDocument(documentFromRow(row) as RuntimeSearchDocumentLike),
      })),
    );

    try {
      if (sourceIds && sourceIds.length > 0) {
        vectorBackend.removeByIds(
          documentsBySource.flatMap((entry) => entry.rows.map((row) => row.path)),
        );
        vectorBackend.upsert(records);
      } else {
        vectorBackend.rebuild(records);
      }

      for (const entry of documentsBySource) {
        updateSourceVectorState({
          sourceId: entry.sourceId,
          vectorDocumentCount: entry.rows.length,
          vectorError: null,
        });
      }
      vectorBackend.markRebuilt();
    } catch (cause) {
      const error = toError(cause).message;
      for (const entry of documentsBySource) {
        updateSourceVectorState({
          sourceId: entry.sourceId,
          vectorDocumentCount: null,
          vectorError: error,
        });
      }
    }
  };

  const searchRows = (searchInput: {
    query: string;
    includeSchemas: boolean;
    limit: number;
    namespace?: string;
    sourceId?: string;
  }): SearchResult => {
    const ftsQuery = buildFtsQuery(searchInput.query);
    if (mode === "fts" && ftsQuery === null) {
      return buildSearchResult({
        provider: activeProviderInfo(),
        results: [],
      });
    }

    const queryTokens = tokenize(searchInput.query);
    const namespace = trimOrNull(searchInput.namespace);

    const candidateLimit =
      mode === "hybrid"
        ? Math.max(searchInput.limit * 3, maxCandidates)
        : searchInput.limit;
    const ftsRows =
      ftsQuery === null
        ? []
        : (() => {
            const clauses = [`${SEARCH_FTS_TABLE} MATCH ?`];
            const params: unknown[] = [ftsQuery];

            if (namespace !== null) {
              clauses.push("namespace = ?");
              params.push(namespace);
            }

            if (searchInput.sourceId !== undefined) {
              clauses.push("source_id = ?");
              params.push(searchInput.sourceId);
            }

            params.push(candidateLimit);
            return queryAll<SearchDocumentRow & { rank: number }>(
              `
                SELECT
                  ${SEARCH_DOCUMENTS_TABLE}.*,
                  bm25(${SEARCH_FTS_TABLE}) AS rank
                FROM ${SEARCH_FTS_TABLE}
                JOIN ${SEARCH_DOCUMENTS_TABLE}
                  ON ${SEARCH_DOCUMENTS_TABLE}.id = ${SEARCH_FTS_TABLE}.rowid
                WHERE ${clauses.join(" AND ")}
                ORDER BY rank ASC, ${SEARCH_DOCUMENTS_TABLE}.path ASC
                LIMIT ?
              `,
              params,
            );
          })();

    if (mode === "fts") {
      const results = ftsRows
        .slice(0, searchInput.limit)
        .map((row) =>
          searchResultItemFromDocument({
            document: documentFromRow(row),
            score: Math.max(0.0001, 100 / (1 + Math.max(row.rank, 0))),
            includeSchemas: searchInput.includeSchemas,
            metadata: {
              retrievalMode: "fts",
              ftsRank: row.rank,
            },
          }));

      return buildSearchResult({
        provider: activeProviderInfo(),
        results,
      });
    }

    const candidates = new Map<string, HybridCandidate>();
    const ensureCandidate = (row: SearchDocumentRow): HybridCandidate => {
      const existing = candidates.get(row.path);
      if (existing) {
        return existing;
      }

      const document = documentFromRow(row);
      const candidate: HybridCandidate = {
        document,
        score: 0,
        lexicalScore: lexicalScore(queryTokens, document),
      };
      candidates.set(row.path, candidate);
      return candidate;
    };

    for (const [index, row] of ftsRows.entries()) {
      const candidate = ensureCandidate(row);
      const rankScore = ranking.ftsWeight / (ranking.rrfK + index + 1);
      candidate.score += rankScore;
      candidate.ftsRank = index + 1;
      candidate.ftsScore = rankScore;
      candidate.ftsRawRank = row.rank;
    }

    if (vectorBackend?.isAvailable() === true) {
      const queryEmbedding = embedder.embedQuery(searchInput.query);
      const vectorMatches = vectorBackend.search({
        embedding: queryEmbedding,
        limit: candidateLimit,
      });
      const vectorRows = fetchRowsByPaths({
        paths: vectorMatches.map((match) => match.id),
        sourceId: searchInput.sourceId,
        namespace: searchInput.namespace,
      });
      const rowsByPath = new Map(vectorRows.map((row) => [row.path, row]));

      for (const [index, match] of vectorMatches.entries()) {
        const row = rowsByPath.get(match.id);
        if (!row) {
          continue;
        }

        const candidate = ensureCandidate(row);
        const rankScore = ranking.vectorWeight / (ranking.rrfK + index + 1);
        candidate.score += rankScore;
        candidate.vectorRank = index + 1;
        candidate.vectorScore = rankScore;
        candidate.vectorDistance = match.distance;
      }
    }

    if (candidates.size < searchInput.limit) {
      const fallbackRows = searchInput.sourceId !== undefined
        ? fetchSourceDocs(searchInput.sourceId)
        : fetchWorkspaceDocs({
            query: searchInput.query,
            namespace: searchInput.namespace,
            limit: searchInput.limit,
            includeSchemas: searchInput.includeSchemas,
          });

      for (const row of fallbackRows) {
        if (candidates.size >= searchInput.limit) {
          break;
        }
        if (candidates.has(row.path)) {
          continue;
        }

        const candidate = ensureCandidate(row);
        if (candidate.lexicalScore <= 0) {
          candidates.delete(row.path);
          continue;
        }

        candidate.score += candidate.lexicalScore * 0.001;
      }
    }

    const reranked = reranker.rerank({
      query: searchInput.query,
      candidates: [...candidates.entries()].map(([id, candidate]) => ({
        id,
        score: candidate.score,
        lexicalScore: candidate.lexicalScore,
        ftsRank: candidate.ftsRank,
        ftsScore: candidate.ftsScore,
        ftsRawRank: candidate.ftsRawRank,
        vectorRank: candidate.vectorRank,
        vectorScore: candidate.vectorScore,
        vectorDistance: candidate.vectorDistance,
      })),
    });

    const results = reranked
      .map((candidate) => {
        const match = candidates.get(candidate.id);
        if (!match) {
          return null;
        }

        const retrievalMode =
          candidate.ftsRank !== undefined && candidate.vectorRank !== undefined
            ? "hybrid"
            : candidate.vectorRank !== undefined
              ? "vector"
              : candidate.ftsRank !== undefined
                ? "fts"
                : "lexical";

        return searchResultItemFromDocument({
          document: match.document,
          score: candidate.score,
          includeSchemas: searchInput.includeSchemas,
          metadata: {
            retrievalMode,
            lexicalScore: candidate.lexicalScore,
            reranker: reranker.key,
            ...(candidate.ftsRank !== undefined
              ? {
                  ftsRank: candidate.ftsRank,
                  ftsScore: candidate.ftsScore,
                  ftsRawRank: candidate.ftsRawRank,
                }
              : {}),
            ...(candidate.vectorRank !== undefined
              ? {
                  vectorRank: candidate.vectorRank,
                  vectorScore: candidate.vectorScore,
                  vectorDistance: candidate.vectorDistance,
                  vectorBackend: vectorBackend?.key ?? null,
                  embedder: embedder.key,
                }
              : {}),
          },
        });
      })
      .filter((result): result is SearchResultItem => result !== null)
      .slice(0, searchInput.limit);

    return buildSearchResult({
      provider: activeProviderInfo(),
      results,
    });
  };

  const status = (): SearchProviderStatus => {
    const sourceCount = queryAll<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${SEARCH_SOURCES_TABLE}`,
    )[0]?.count ?? 0;
    const documentCount = queryAll<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${SEARCH_DOCUMENTS_TABLE}`,
    )[0]?.count ?? 0;
    const staleSourceCount = mode === "hybrid"
      ? vectorBackend?.isRebuildRequired() === true
        ? sourceCount
        : queryAll<{ count: number }>(
            `
              SELECT COUNT(*) AS count
              FROM ${SEARCH_SOURCES_TABLE}
              WHERE ${staleHybridSourceWhere}
            `,
            [currentVectorBackendKey, currentEmbedderKey],
          )[0]?.count ?? 0
      : 0;
    const healthy = mode === "fts" || vectorBackend?.isAvailable() === true;
    const detailParts = [`db=${databasePath}`];

    if (mode === "hybrid") {
      detailParts.push(`embedder=${embedder.key}`);
      detailParts.push(
        `vector=${vectorBackend?.isAvailable() === true ? vectorBackend.key : "degraded"}`,
      );
      if (vectorBackend?.detail()) {
        detailParts.push(`vector_detail=${vectorBackend.detail()}`);
      }
    }

    return {
      ...activeProviderInfo(),
      configuredProviderKey: SQLITE_SEARCH_PROVIDER_KEY,
      healthy,
      detail: detailParts.join(" "),
      sourceCount,
      documentCount,
      staleSourceCount,
    };
  };

  return {
    key: SQLITE_SEARCH_PROVIDER_KEY,
    init: async () => {
      ensureDatabase();
      await ensureHybridVectorBackend();
      if (mode === "hybrid" && vectorBackend?.isAvailable() === true) {
        const staleSourceIds = fetchStaleHybridSourceIds();
        if (staleSourceIds.length > 0) {
          rebuildVectors(staleSourceIds);
        }
      }
    },
    searchWorkspace: (request: SearchWorkspaceRequest) =>
      searchRows({
        ...request,
        includeSchemas: request.includeSchemas,
      }),
    discoverSource: (request: SearchSourceRequest) =>
      searchRows({
        query: request.query,
        includeSchemas: request.includeSchemas,
        limit: request.limit,
        sourceId: request.sourceId,
      }),
    syncSourceCatalog: (payload: SearchProviderSyncPayload) => {
      upsertDocuments(payload);
    },
    removeSource: ({ sourceId }) => {
      deleteSourceRows(sourceId);
    },
    status,
    refresh: async () => {
      ensureDatabase().sqlite.exec("PRAGMA optimize;");
      await ensureHybridVectorBackend();
      if (mode === "hybrid" && vectorBackend?.isAvailable() === true) {
        const staleSourceIds = fetchStaleHybridSourceIds();
        if (staleSourceIds.length > 0) {
          rebuildVectors(staleSourceIds);
        }
      }
      return status();
    },
    rebuild: async () => {
      ensureDatabase().sqlite
        .prepare(`INSERT INTO ${SEARCH_FTS_TABLE}(${SEARCH_FTS_TABLE}) VALUES (?)`)
        .run("rebuild");
      await ensureHybridVectorBackend();
      if (mode === "hybrid") {
        rebuildVectors();
      }
      return status();
    },
  };
};
