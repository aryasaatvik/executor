import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";

import type { LocalExecutorConfig, SecretRef } from "#schema";

import { createEmbedder, type Embedder } from "../../../db/embedder";

const semanticSearchEmbedderCache = new Map<
  string,
  Promise<Embedder | undefined>
>();

type ResolvedSemanticSearchConfig = NonNullable<LocalExecutorConfig["semanticSearch"]> extends infer Config
  ? Config extends { apiKeyRef?: unknown }
    ? Omit<Config, "apiKeyRef"> & { apiKey?: string }
    : never
  : never;

export const clearSemanticSearchEmbedderCacheForTests = (): void => {
  semanticSearchEmbedderCache.clear();
};

export const workspaceCatalogCacheKey = (input: {
  stateDirectory: string;
  workspaceId: string;
  accountId: string;
}): string =>
  JSON.stringify(input);

export const workspaceCatalogIndexSignature = (input: {
  embedder?: Embedder;
}): string =>
  JSON.stringify({
    embedder: input.embedder
      ? {
          provider: input.embedder.provider,
          model: input.embedder.model,
          dimensions: input.embedder.dimensions,
        }
      : null,
  });

const resolveConfiguredSemanticSearchConfig = (
  resolveSecretMaterial: (input: { ref: SecretRef }) => Effect.Effect<string, unknown, never>,
  config: LocalExecutorConfig | null | undefined,
): Effect.Effect<ResolvedSemanticSearchConfig | undefined, unknown, never> => {
  const semanticSearchConfig = config?.semanticSearch;
  if (!semanticSearchConfig) {
    return Effect.succeed(undefined);
  }

  if (semanticSearchConfig.provider === "local") {
    if (semanticSearchConfig.apiKeyRef !== undefined) {
      return Effect.fail(
        new Error('Local semantic search does not accept "apiKeyRef".'),
      );
    }

    return Effect.succeed({
      provider: semanticSearchConfig.provider,
      ...(semanticSearchConfig.model !== undefined
        ? { model: semanticSearchConfig.model }
        : {}),
      ...(semanticSearchConfig.dimensions !== undefined
        ? { dimensions: semanticSearchConfig.dimensions }
        : {}),
    });
  }

  if (
    semanticSearchConfig.provider !== "google" &&
    semanticSearchConfig.provider !== "openai"
  ) {
    return Effect.fail(
      new Error(
        `Semantic search provider "${semanticSearchConfig.provider}" is not supported.`,
      ),
    );
  }

  if (!semanticSearchConfig.apiKeyRef) {
    return Effect.fail(
      new Error(
        `Semantic search provider "${semanticSearchConfig.provider}" requires an apiKeyRef secret.`,
      ),
    );
  }

  return Effect.map(
    resolveSecretMaterial({ ref: semanticSearchConfig.apiKeyRef as SecretRef }),
    (apiKey) => ({
      provider: semanticSearchConfig.provider,
      ...(semanticSearchConfig.model !== undefined
        ? { model: semanticSearchConfig.model }
        : {}),
      ...(semanticSearchConfig.dimensions !== undefined
        ? { dimensions: semanticSearchConfig.dimensions }
        : {}),
      apiKey,
    }),
  );
};

const getCachedSemanticSearchEmbedder = (
  config: ResolvedSemanticSearchConfig,
  createEmbedderImpl: typeof createEmbedder,
): Promise<Embedder | undefined> => {
  const cacheKey = JSON.stringify({
    provider: config.provider,
    model: config.model ?? null,
    apiKeyHash: config.apiKey
      ? createHash("sha256").update(config.apiKey).digest("hex")
      : null,
    dimensions: config.dimensions ?? null,
  });
  const existing = semanticSearchEmbedderCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const pending = createEmbedderImpl(config).then(async (embedder) => {
    if (!embedder) {
      return undefined;
    }

    if (config.provider === "local" && config.dimensions == null) {
      await embedder.embed("__executor_dimension_probe__", "document");
    }

    return embedder;
  });
  semanticSearchEmbedderCache.set(cacheKey, pending);
  return pending.catch((error) => {
    semanticSearchEmbedderCache.delete(cacheKey);
    throw error;
  });
};

export const loadConfiguredSemanticSearchEmbedder = (
  resolveSecretMaterial: (input: { ref: SecretRef }) => Effect.Effect<string, unknown, never>,
  config: LocalExecutorConfig | null | undefined,
  options?: {
    createEmbedder?: typeof createEmbedder;
  },
): Effect.Effect<Embedder | undefined, unknown, never> =>
  Effect.flatMap(
    resolveConfiguredSemanticSearchConfig(resolveSecretMaterial, config),
    (semanticSearchConfig) => {
      if (!semanticSearchConfig) {
        return Effect.succeed(undefined);
      }

      return Effect.tryPromise({
        try: () =>
          getCachedSemanticSearchEmbedder(
            semanticSearchConfig,
            options?.createEmbedder ?? createEmbedder,
          ),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      }).pipe(
        Effect.map((embedder) => embedder ?? undefined),
      );
    },
  );
