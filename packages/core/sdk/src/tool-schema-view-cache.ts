import { Effect, Schema } from "effect";

import { sha256Hex } from "./blob";
import { cacheKeyPayload } from "./cache-key";
import {
  TOOL_TYPESCRIPT_PREVIEW_CACHE_VERSION,
  TOOL_TYPESCRIPT_PREVIEW_COMPILER_VERSION,
} from "./tool-typescript-preview-cache";
import { ToolSchemaView } from "./types";

export const TOOL_SCHEMA_VIEW_CACHE_PREFIX = "tool-schema-view/";
export const TOOL_SCHEMA_VIEW_CACHE_VERSION = "v1";

export const ToolSchemaViewCacheEntry = Schema.Struct({
  version: Schema.Literal(TOOL_SCHEMA_VIEW_CACHE_VERSION),
  typeScriptPreviewCacheVersion: Schema.Literal(TOOL_TYPESCRIPT_PREVIEW_CACHE_VERSION),
  typeScriptPreviewCompilerVersion: Schema.Literal(TOOL_TYPESCRIPT_PREVIEW_COMPILER_VERSION),
  view: ToolSchemaView,
});

interface ToolSchemaViewCacheKeyInput {
  readonly address: string;
  readonly name?: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly definitions: Readonly<Record<string, unknown>>;
}

const cachePayload = (input: ToolSchemaViewCacheKeyInput): string =>
  cacheKeyPayload({
    version: TOOL_SCHEMA_VIEW_CACHE_VERSION,
    typeScriptPreviewCacheVersion: TOOL_TYPESCRIPT_PREVIEW_CACHE_VERSION,
    typeScriptPreviewCompilerVersion: TOOL_TYPESCRIPT_PREVIEW_COMPILER_VERSION,
    address: input.address,
    name: input.name,
    description: input.description,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    definitions: input.definitions,
  });

export const toolSchemaViewCacheKey = (input: ToolSchemaViewCacheKeyInput): Effect.Effect<string> =>
  sha256Hex(cachePayload(input)).pipe(
    Effect.map(
      (hash) => `${TOOL_SCHEMA_VIEW_CACHE_PREFIX}${TOOL_SCHEMA_VIEW_CACHE_VERSION}/${hash}`,
    ),
  );
