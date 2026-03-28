import type { ToolCatalog } from "@executor/codemode-core";
import { toToolToIndex } from "@executor/core/services/execution";
import type { AccountId, Source } from "@executor/core/model";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import { SqliteToolCatalogLive, SqliteToolCatalogService } from "../db/catalog";
import {
  loadSemanticSearchSignature,
  writeSemanticSearchSignature,
} from "../db/indexer";
import {
  embedSourceTools,
  removeSourceEmbeddings,
} from "../db/embed-indexer";
import type { RuntimeLocalWorkspaceState } from "../config/runtime-context";
import { makeWorkspaceDatabase } from "../stores/workspace-database";

type Embedder = {
  dimensions: number;
  embed: (text: string, mode: "query" | "document") => Promise<number[]>;
  embedBatch: (texts: readonly string[], mode: "query" | "document") => Promise<number[][]>;
  provider?: string;
  model?: string;
};

type SourceCatalogStoreShape = {
  loadWorkspaceSourceCatalogToolIndex: (input: {
    workspaceId: Source["workspaceId"];
    actorAccountId: AccountId;
    includeSchemas: boolean;
  }) => Effect.Effect<readonly Parameters<typeof toToolToIndex>[0][], Error>;
};

const workspaceCatalogIndexSignature = (input: {
  embedder?: Embedder;
}): string =>
  JSON.stringify({
    embedder: input.embedder
      ? {
          provider: input.embedder.provider ?? null,
          model: input.embedder.model ?? null,
          dimensions: input.embedder.dimensions,
        }
      : null,
  });

export const acquireLocalWorkspaceSourceCatalog = (input: {
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState;
  embedder?: Embedder;
}) =>
  Effect.gen(function* () {
    if (!input.runtimeLocalWorkspace) {
      return yield* Effect.fail(
        new Error("Runtime local workspace is required for the SQLite source catalog."),
      );
    }

    const workspaceDatabase = makeWorkspaceDatabase(input.runtimeLocalWorkspace);
    const scope = yield* Scope.make();
    const sqliteCatalogContext = yield* Layer.buildWithScope(
      SqliteToolCatalogLive(input.embedder).pipe(
        Layer.provide(workspaceDatabase.queryLayer(
          input.embedder
            ? { embeddingDimensions: input.embedder.dimensions }
            : undefined,
        )),
      ),
      scope,
    );

    const catalog = Context.get(sqliteCatalogContext, SqliteToolCatalogService);

    return {
      catalog,
      close: Scope.close(scope, Exit.void),
    };
  });

export const createLocalWorkspaceSourceCatalog = (input: {
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState;
  embedder?: Embedder;
}): ToolCatalog => {
  const withManagedSqliteCatalog = <A>(
    useCatalog: (catalog: ToolCatalog) => Effect.Effect<A, unknown, never>,
  ): Effect.Effect<A, unknown, never> =>
    Effect.acquireUseRelease(
      acquireLocalWorkspaceSourceCatalog(input),
      ({ catalog }) => useCatalog(catalog),
      ({ close }) => close,
    );

  return {
    searchTools: (params) =>
      withManagedSqliteCatalog((catalog) => catalog.searchTools(params)),
    listTools: (params) =>
      withManagedSqliteCatalog((catalog) => catalog.listTools(params)),
    listNamespaces: (params) =>
      withManagedSqliteCatalog((catalog) => catalog.listNamespaces(params)),
    getToolByPath: (params) =>
      withManagedSqliteCatalog((catalog) => catalog.getToolByPath(params)),
  } satisfies ToolCatalog;
};

export const indexLocalWorkspaceToolsIntoSqlite = (input: {
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  sourceCatalogStore: SourceCatalogStoreShape;
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState;
  embedder?: Embedder;
}) =>
  Effect.gen(function* () {
    if (!input.runtimeLocalWorkspace) {
      return;
    }

    const workspaceDatabase = makeWorkspaceDatabase(input.runtimeLocalWorkspace);
    const nextSignature = workspaceCatalogIndexSignature({
      embedder: input.embedder,
    });

    const previousSignature = yield* loadSemanticSearchSignature(
      input.workspaceId,
    ).pipe(
      workspaceDatabase.provideWrite,
      Effect.catchAll(() => Effect.succeed(null)),
    );

    if (previousSignature === nextSignature) {
      return;
    }

    if (input.embedder) {
      const tools = yield* input.sourceCatalogStore.loadWorkspaceSourceCatalogToolIndex({
        workspaceId: input.workspaceId,
        actorAccountId: input.accountId,
        includeSchemas: true,
      });

      const toolsBySourceKey = new Map<string, ReturnType<typeof toToolToIndex>[]>();
      for (const tool of tools) {
        if (!tool.source.enabled || tool.source.status !== "connected") {
          continue;
        }

        const sourceKey = tool.descriptor.sourceKey;
        const indexedTool = toToolToIndex(tool);
        const existing = toolsBySourceKey.get(sourceKey);
        if (existing) {
          existing.push(indexedTool);
        } else {
          toolsBySourceKey.set(sourceKey, [indexedTool]);
        }
      }

      for (const [sourceKey, indexedTools] of toolsBySourceKey) {
        yield* removeSourceEmbeddings(sourceKey).pipe(
          workspaceDatabase.provideWrite,
        );
        yield* embedSourceTools({
          embedder: input.embedder,
          tools: indexedTools,
          sourceKey,
        }).pipe(
          workspaceDatabase.provideWrite,
        );
      }
    }

    yield* writeSemanticSearchSignature(
      input.workspaceId,
      nextSignature,
    ).pipe(workspaceDatabase.provideWrite);
  });
