import { SqlClient } from "@effect/sql";
import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";
import type {
  SearchHit,
  ToolCatalog,
  ToolContract,
  ToolDescriptor,
  ToolNamespace,
  ToolPath,
} from "@executor/codemode-core";
import { and, eq, sql as drizzleSql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { reciprocalRankFusion } from "./rrf";
import { catalog_tool } from "./schema";
import { VecService } from "./vec";

type Embedder = {
  dimensions: number;
  embed: (text: string, mode: "query" | "document") => Promise<number[]>;
};

const buildFtsQuery = (query: string): string =>
  query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, "\"\"")}"`)
    .join(" ");

const rowToDescriptor = (
  row: {
    path: string;
    sourceKey: string;
    description: string | null;
    interaction: string | null;
    inputTypePreview: string | null;
    outputTypePreview: string | null;
    inputSchemaJson: unknown;
    outputSchemaJson: unknown;
    providerKind: string | null;
  },
  includeSchemas: boolean,
): ToolDescriptor => {
  const contract: ToolContract = {
    ...(row.inputTypePreview != null ? { inputTypePreview: row.inputTypePreview } : {}),
    ...(row.outputTypePreview != null ? { outputTypePreview: row.outputTypePreview } : {}),
    ...(includeSchemas && row.inputSchemaJson != null ? { inputSchema: row.inputSchemaJson } : {}),
    ...(includeSchemas && row.outputSchemaJson != null ? { outputSchema: row.outputSchemaJson } : {}),
  };

  return {
    path: row.path as ToolPath,
    sourceKey: row.sourceKey,
    ...(row.description != null ? { description: row.description } : {}),
    interaction: (row.interaction ?? "auto") as "auto" | "required",
    ...(Object.keys(contract).length > 0 ? { contract } : {}),
    ...(row.providerKind != null ? { providerKind: row.providerKind } : {}),
  };
};

const descriptorColumns = {
  path: catalog_tool.path,
  sourceKey: catalog_tool.sourceKey,
  description: catalog_tool.description,
  interaction: catalog_tool.interaction,
  inputTypePreview: catalog_tool.inputTypePreview,
  outputTypePreview: catalog_tool.outputTypePreview,
  inputSchemaJson: catalog_tool.inputSchemaJson,
  outputSchemaJson: catalog_tool.outputSchemaJson,
  providerKind: catalog_tool.providerKind,
} as const;

const lexicalScoreFromBm25 = (bm25Score: number): number => {
  const magnitude = Math.max(0, -bm25Score);
  return magnitude / (1 + magnitude);
};

const withSearchMode = (
  hits: readonly SearchHit[],
  searchMode: "fts" | "semantic" | "hybrid",
): readonly SearchHit[] =>
  Object.assign([...hits], { searchMode }) as readonly SearchHit[];

export class SqliteToolCatalogService extends Context.Tag(
  "#db/SqliteToolCatalogService",
)<SqliteToolCatalogService, ToolCatalog>() {}

const makeSqliteToolCatalog = (
  embedder?: Embedder,
): Effect.Effect<ToolCatalog, never, SqliteDrizzle | SqlClient.SqlClient | VecService> =>
  Effect.gen(function* () {
    const sqlClient = yield* SqlClient.SqlClient;
    const drizzleDb = yield* SqliteDrizzle;
    const vec = yield* VecService;

    const runtimeLayer = Layer.mergeAll(
      Layer.succeed(SqlClient.SqlClient, sqlClient),
      Layer.succeed(SqliteDrizzle, drizzleDb),
      Layer.succeed(VecService, vec),
    );

    const run = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient | SqliteDrizzle | VecService>) =>
      Effect.provide(effect, runtimeLayer);

    return {
      searchTools: ({ query, namespace, sourceKey, limit }) =>
        run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const vec = yield* VecService;
            const trimmedQuery = query.trim();
            if (trimmedQuery.length === 0) {
              return withSearchMode([], "fts");
            }

            const ftsQuery = buildFtsQuery(trimmedQuery);
            const namespaceClause = namespace ? "AND t.namespace = ?" : "";
            const sourceKeyClause = sourceKey ? "AND t.source_key = ?" : "";
            const ftsLimit = embedder ? limit * 2 : limit;
            const params: Array<string | number> = [
              ftsQuery,
              ...(namespace ? [namespace] : []),
              ...(sourceKey ? [sourceKey] : []),
              ftsLimit,
            ];

            const rows = ftsQuery.length === 0
              ? []
              : yield* sql.unsafe<{ path: string; raw_score: number }>(
                  `SELECT t.path,
                          bm25(catalog_tool_fts, 10.0, 8.0, 2.0, 1.0) as raw_score
                   FROM catalog_tool_fts
                   JOIN catalog_tool t ON t.rowid = catalog_tool_fts.rowid
                   WHERE catalog_tool_fts MATCH ?
                     AND t.source_enabled = 1
                     AND t.source_status = 'connected'
                     ${namespaceClause}
                     ${sourceKeyClause}
                   ORDER BY raw_score ASC
                   LIMIT ?`,
                  params,
                );

            const ftsResults: readonly SearchHit[] = rows.map((row) => ({
              path: row.path as ToolPath,
              score: lexicalScoreFromBm25(row.raw_score),
            }));

            if (!embedder) {
              return withSearchMode(ftsResults.slice(0, limit), "fts");
            }

            if (ftsResults.length > 0 && ftsResults[0].score >= 0.85) {
              const gap = ftsResults.length > 1
                ? ftsResults[0].score - ftsResults[1].score
                : ftsResults[0].score;
              if (gap >= 0.15) {
                return withSearchMode(ftsResults.slice(0, limit), "fts");
              }
            }

            const queryEmbedding = yield* Effect.tryPromise({
              try: () => embedder.embed(trimmedQuery, "query"),
              catch: (cause) =>
                cause instanceof Error ? cause : new Error(String(cause)),
            });

            if (!(yield* vec.hasVecTable())) {
              return withSearchMode(ftsResults.slice(0, limit), "fts");
            }

            const vecResults = yield* vec.searchVec({
              queryEmbedding,
              limit: limit * 2,
              ...(sourceKey ? { sourceFilter: sourceKey } : {}),
              ...(namespace ? { namespaceFilter: namespace } : {}),
            });

            const hybridResults = reciprocalRankFusion(
              [
                { results: ftsResults, weight: 1.5 },
                {
                  results: vecResults.map((result) => ({
                    path: result.toolId as ToolPath,
                    score: result.score,
                  })),
                  weight: 1.0,
                },
              ],
              60,
              limit,
            );

            return withSearchMode(
              hybridResults as readonly SearchHit[],
              ftsResults.length === 0 ? "semantic" : "hybrid",
            );
          }),
        ),

      listTools: ({ namespace, query, limit, includeSchemas = false }) =>
        run(
          Effect.gen(function* () {
            if (query) {
              const sql = yield* SqlClient.SqlClient;
              const trimmedQuery = query.trim();
              if (trimmedQuery.length === 0) {
                return [] as readonly ToolDescriptor[];
              }

              const ftsQuery = buildFtsQuery(trimmedQuery);
              if (ftsQuery.length === 0) {
                return [] as readonly ToolDescriptor[];
              }

              const namespaceClause = namespace ? "AND t.namespace = ?" : "";
              const params: Array<string | number> = namespace
                ? [ftsQuery, namespace, limit]
                : [ftsQuery, limit];

              const rows = yield* sql.unsafe<{
                path: string;
                sourceKey: string;
                description: string | null;
                interaction: string | null;
                inputTypePreview: string | null;
                outputTypePreview: string | null;
                inputSchemaJson: string | null;
                outputSchemaJson: string | null;
                providerKind: string | null;
              }>(
                `SELECT t.path AS path, t.source_key AS sourceKey,
                        t.description AS description, t.interaction AS interaction,
                        t.input_type_preview AS inputTypePreview,
                        t.output_type_preview AS outputTypePreview,
                        t.input_schema_json AS inputSchemaJson,
                        t.output_schema_json AS outputSchemaJson,
                        t.provider_kind AS providerKind
                 FROM catalog_tool_fts
                 JOIN catalog_tool t ON t.rowid = catalog_tool_fts.rowid
                 WHERE catalog_tool_fts MATCH ?
                   AND t.source_enabled = 1
                   AND t.source_status = 'connected'
                   ${namespaceClause}
                 ORDER BY bm25(catalog_tool_fts, 10.0, 8.0, 2.0, 1.0)
                 LIMIT ?`,
                params,
              );

              return rows.map((row) =>
                rowToDescriptor(
                  {
                    ...row,
                    inputSchemaJson: row.inputSchemaJson ? JSON.parse(row.inputSchemaJson) : null,
                    outputSchemaJson: row.outputSchemaJson ? JSON.parse(row.outputSchemaJson) : null,
                  },
                  includeSchemas,
                ),
              ) as readonly ToolDescriptor[];
            }

            const db = yield* SqliteDrizzle;
            const conditions = [
              eq(catalog_tool.sourceEnabled, true),
              eq(catalog_tool.sourceStatus, "connected"),
            ];
            if (namespace) {
              conditions.push(eq(catalog_tool.namespace, namespace));
            }

            const rows = yield* db
              .select(descriptorColumns)
              .from(catalog_tool)
              .where(and(...conditions))
              .limit(limit);

            return rows.map((row) => rowToDescriptor(row, includeSchemas)) as readonly ToolDescriptor[];
          }),
        ),

      listNamespaces: ({ limit }) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select({
                namespace: catalog_tool.namespace,
                toolCount: drizzleSql<number>`COUNT(*)`.as("toolCount"),
              })
              .from(catalog_tool)
              .where(and(
                eq(catalog_tool.sourceEnabled, true),
                eq(catalog_tool.sourceStatus, "connected"),
              ))
              .groupBy(catalog_tool.namespace)
              .limit(limit);

            return rows.map((row) => ({
              namespace: row.namespace,
              toolCount: row.toolCount,
            })) as readonly ToolNamespace[];
          }),
        ),

      getToolByPath: ({ path, includeSchemas }) =>
        run(
          Effect.gen(function* () {
            const db = yield* SqliteDrizzle;
            const rows = yield* db
              .select(descriptorColumns)
              .from(catalog_tool)
              .where(and(
                eq(catalog_tool.path, path),
                eq(catalog_tool.sourceEnabled, true),
                eq(catalog_tool.sourceStatus, "connected"),
              ))
              .limit(1);

            if (rows.length === 0) {
              return null;
            }

            return rowToDescriptor(rows[0], includeSchemas);
          }),
        ),
    } satisfies ToolCatalog;
  });

export const SqliteToolCatalogLive = (embedder?: Embedder) =>
  Layer.effect(SqliteToolCatalogService, makeSqliteToolCatalog(embedder));

export const createSqliteToolCatalog = makeSqliteToolCatalog;
