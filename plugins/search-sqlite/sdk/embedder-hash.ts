import * as Layer from "effect/Layer";

import {
  SearchEmbedderService,
  type SearchEmbedder,
  type SearchEmbedderInput,
  embeddingTextFromInput,
} from "./embedder";
import {
  makeSqliteSearchEmbedderSignature,
} from "./shared";

const tokenize = (value: string): string[] =>
  value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const normalizeUnitVector = (vector: Float32Array): Float32Array => {
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }

  if (norm <= 0) {
    return vector;
  }

  const scale = 1 / Math.sqrt(norm);
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = vector[index]! * scale;
  }
  return vector;
};

const hashString = (value: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const addFeature = (
  vector: Float32Array,
  feature: string,
  weight: number,
) => {
  const hash = hashString(feature);
  const index = hash % vector.length;
  const sign = (hash >>> 31) === 0 ? 1 : -1;
  vector[index] = (vector[index] ?? 0) + weight * sign;
};

const addTokenFeatures = (
  vector: Float32Array,
  value: string,
  prefix: string,
  weight: number,
) => {
  const tokens = tokenize(value);
  for (const token of tokens) {
    addFeature(vector, `${prefix}:${token}`, weight);
  }

  for (let index = 0; index < tokens.length - 1; index += 1) {
    addFeature(vector, `${prefix}:${tokens[index]}_${tokens[index + 1]}`, weight * 0.6);
  }
};

const addCharacterTrigrams = (
  vector: Float32Array,
  value: string,
  prefix: string,
  weight: number,
) => {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (normalized.length < 3) {
    return;
  }

  for (let index = 0; index <= normalized.length - 3; index += 1) {
    const trigram = normalized.slice(index, index + 3);
    if (trigram.includes(" ")) {
      continue;
    }
    addFeature(vector, `${prefix}:tri:${trigram}`, weight);
  }
};

const buildHashEmbedding = (
  input: SearchEmbedderInput,
  dimensions: number,
): Float32Array => {
  const vector = new Float32Array(dimensions);
  const text = embeddingTextFromInput(input);

  addTokenFeatures(vector, text, "text", 1.2);
  addCharacterTrigrams(vector, text, "text", 0.12);

  if (input.kind === "document") {
    if (input.document.title) {
      addTokenFeatures(vector, input.document.title, "title", 3);
      addCharacterTrigrams(vector, input.document.title, "title", 0.2);
    }

    if (input.document.description) {
      addTokenFeatures(vector, input.document.description, "description", 1.5);
    }

    addTokenFeatures(vector, input.document.namespace, "namespace", 2.2);
    addTokenFeatures(vector, input.document.path, "path", 2.4);
    addCharacterTrigrams(vector, input.document.path, "path", 0.18);

    for (const tag of input.document.tags) {
      addTokenFeatures(vector, tag, "tag", 2.4);
    }
  } else {
    addTokenFeatures(vector, input.query, "title", 3);
    addCharacterTrigrams(vector, input.query, "title", 0.2);
  }

  return normalizeUnitVector(vector);
};

export const createHashEmbedder = (input?: {
  dimensions?: number;
}): SearchEmbedder => {
  const dimensions = Math.max(64, Math.floor(input?.dimensions ?? 256));
  const key = "hash-v1";

  return {
    key,
    dimensions,
    signature: makeSqliteSearchEmbedderSignature({
      key,
      dimensions,
    }),
    embed: async (inputValue) => buildHashEmbedding(inputValue, dimensions),
    embedMany: async (inputValues) =>
      inputValues.map((inputValue) => buildHashEmbedding(inputValue, dimensions)),
  };
};

export const HashEmbedderLayer = (input?: {
  dimensions?: number;
}) => Layer.succeed(SearchEmbedderService, createHashEmbedder(input));
