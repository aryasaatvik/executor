import { Effect, Schema } from "effect";

import { sha256Hex } from "./blob";
import type { TypeScriptRenderOptions } from "./schema-types";

export const TOOL_TYPESCRIPT_PREVIEW_CACHE_PREFIX = "tool-typescript-preview/";
export const TOOL_TYPESCRIPT_PREVIEW_CACHE_VERSION = "v1";
export const TOOL_TYPESCRIPT_PREVIEW_COMPILER_VERSION = "json-schema-to-typescript-vendored";

const ToolTypeScriptPreviewValue = Schema.Struct({
  inputTypeScript: Schema.optional(Schema.String),
  outputTypeScript: Schema.optional(Schema.String),
  typeScriptDefinitions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

export const ToolTypeScriptPreviewCacheEntry = Schema.Struct({
  version: Schema.Literal(TOOL_TYPESCRIPT_PREVIEW_CACHE_VERSION),
  compilerVersion: Schema.Literal(TOOL_TYPESCRIPT_PREVIEW_COMPILER_VERSION),
  preview: ToolTypeScriptPreviewValue,
});

interface ToolTypeScriptPreviewCacheKeyInput {
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly definitions: Readonly<Record<string, unknown>>;
  readonly options?: TypeScriptRenderOptions;
}

const normalizeForHash = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeForHash);
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = normalizeForHash((value as Record<string, unknown>)[key]);
  }
  return out;
};

const cachePayload = (input: ToolTypeScriptPreviewCacheKeyInput): string =>
  JSON.stringify(
    normalizeForHash({
      version: TOOL_TYPESCRIPT_PREVIEW_CACHE_VERSION,
      compilerVersion: TOOL_TYPESCRIPT_PREVIEW_COMPILER_VERSION,
      inputSchema: input.inputSchema,
      outputSchema: input.outputSchema,
      definitions: input.definitions,
      options: input.options ?? {},
    }),
  );

export const toolTypeScriptPreviewCacheKey = (
  input: ToolTypeScriptPreviewCacheKeyInput,
): Effect.Effect<string> =>
  sha256Hex(cachePayload(input)).pipe(
    Effect.map(
      (hash) =>
        `${TOOL_TYPESCRIPT_PREVIEW_CACHE_PREFIX}${TOOL_TYPESCRIPT_PREVIEW_CACHE_VERSION}/${TOOL_TYPESCRIPT_PREVIEW_COMPILER_VERSION}/${hash}`,
    ),
  );
