import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import type {
  SearchDocumentLike,
} from "@executor/platform-sdk/runtime";

import type {
  SqliteSearchSemanticEmbedderConfig,
} from "./shared";
import {
  resolveSqliteSearchEmbedderMetadata,
} from "./shared";
import {
  GoogleEmbedderLayer,
} from "./embedder-google";
import {
  HashEmbedderLayer,
} from "./embedder-hash";

export type SearchEmbedderInput =
  | {
      kind: "document";
      document: SearchDocumentLike;
    }
  | {
      kind: "query";
      query: string;
    };

export type SearchEmbedder = {
  key: string;
  dimensions: number;
  signature: string;
  embed: (input: SearchEmbedderInput) => Promise<Float32Array>;
  embedMany: (input: readonly SearchEmbedderInput[]) => Promise<readonly Float32Array[]>;
};

export class SearchEmbedderService extends Context.Tag(
  "#plugins/search-sqlite/SearchEmbedderService",
)<SearchEmbedderService, SearchEmbedder>() {}

export const embeddingTextFromDocument = (document: SearchDocumentLike): string =>
  [
    document.title ?? "",
    document.description ?? "",
    document.protocol ?? "",
    document.method ?? "",
    document.pathTemplate ?? "",
    document.operationId ?? "",
    document.group ?? "",
    document.leaf ?? "",
    document.namespace,
    document.path,
    document.searchText,
    document.tags.join(" "),
  ]
    .filter(Boolean)
    .join(" ");

export const embeddingTextFromInput = (input: SearchEmbedderInput): string =>
  input.kind === "document" ? embeddingTextFromDocument(input.document) : input.query;

export const createSearchEmbedderLayer = (
  config?: SqliteSearchSemanticEmbedderConfig,
): Layer.Layer<SearchEmbedderService, Error, never> => {
  const resolved = resolveSqliteSearchEmbedderMetadata(config);

  return resolved.kind === "google"
    ? GoogleEmbedderLayer({
        dimensions: resolved.dimensions,
      })
    : HashEmbedderLayer({
        dimensions: resolved.dimensions,
      });
};
