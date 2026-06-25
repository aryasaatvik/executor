import type { Executor, Tool, ToolSchemaManifest } from "@executor-js/sdk/core";
import { Effect } from "effect";

import { SemanticSearchError } from "./errors";

const ADDRESS_PREFIX = "tools.";
const MAX_AI_SEARCH_FILE_BYTES = 3_500_000;

const textEncoder = new TextEncoder();

export const stripHtml = (value: string): string =>
  value
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const addressToPath = (address: string): string =>
  address.startsWith(ADDRESS_PREFIX) ? address.slice(ADDRESS_PREFIX.length) : address;

export interface ListToolManifestsOptions {
  readonly maxTools?: number;
}

const selectToolManifests = (
  manifests: readonly ToolSchemaManifest[],
  options?: ListToolManifestsOptions,
): readonly ToolSchemaManifest[] => {
  const sorted = [...manifests].sort((a, b) => a.path.localeCompare(b.path));
  const maxTools = options?.maxTools;
  if (maxTools === undefined) return sorted;
  return sorted.slice(0, Math.max(0, Math.floor(maxTools)));
};

export const listToolManifests = (
  executor: Executor,
  options?: ListToolManifestsOptions,
): Effect.Effect<readonly ToolSchemaManifest[], SemanticSearchError> =>
  executor.tools.manifest().pipe(
    Effect.mapError(
      (cause) =>
        new SemanticSearchError({ message: "Failed to list tool manifests for AI Search.", cause }),
    ),
    Effect.map((manifests) => selectToolManifests(manifests, options)),
  );

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const collectSchemaTerms = (value: unknown, terms: Set<string>, depth = 0): void => {
  if (depth > 10 || terms.size >= 800) return;
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaTerms(item, terms, depth + 1);
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, entry] of Object.entries(value)) {
    if (terms.size >= 800) return;
    if (key === "properties" && isRecord(entry)) {
      for (const property of Object.keys(entry)) terms.add(property);
      collectSchemaTerms(entry, terms, depth + 1);
      continue;
    }
    if (key === "required" && Array.isArray(entry)) {
      for (const required of entry) {
        if (typeof required === "string") terms.add(`required ${required}`);
      }
      continue;
    }
    if ((key === "type" || key === "format" || key === "title") && typeof entry === "string") {
      terms.add(`${key} ${entry}`);
      continue;
    }
    if (key === "enum" && Array.isArray(entry)) {
      for (const item of entry) {
        if (typeof item === "string" && item.length <= 120) terms.add(item);
      }
      continue;
    }
    if (key === "description" && typeof entry === "string") {
      const description = stripHtml(entry);
      if (description.length > 0) terms.add(description.slice(0, 320));
      continue;
    }
    collectSchemaTerms(entry, terms, depth + 1);
  }
};

const schemaSection = (title: string, schema: unknown): string | undefined => {
  const terms = new Set<string>();
  collectSchemaTerms(schema, terms);
  if (terms.size === 0) return undefined;
  return `## ${title}\n\n${Array.from(terms).join("\n")}`;
};

const truncateToAiSearchLimit = (document: string): string => {
  if (textEncoder.encode(document).byteLength <= MAX_AI_SEARCH_FILE_BYTES) return document;
  let low = 0;
  let high = document.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (textEncoder.encode(document.slice(0, mid)).byteLength <= MAX_AI_SEARCH_FILE_BYTES) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return document.slice(0, low);
};

export const toolItemKey = (manifest: ToolSchemaManifest): string =>
  [
    manifest.path,
    manifest.fingerprintVersion,
    manifest.indexFingerprint,
    manifest.sourceRevision ?? "",
  ].join(":");

export interface ToolSearchDocument {
  readonly path: string;
  readonly name: string;
  readonly description: string;
  readonly integration: string;
  readonly connection?: string;
  readonly plugin?: string;
  readonly fingerprint: string;
  readonly content: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export const collectToolSearchDocument = (
  executor: Executor,
  manifest: ToolSchemaManifest,
): Effect.Effect<ToolSearchDocument, SemanticSearchError> => {
  const path = manifest.path;
  const name = manifest.name;
  const description = stripHtml(manifest.description ?? "");
  const fingerprint = toolItemKey(manifest);
  return executor.tools.schema(`${ADDRESS_PREFIX}${path}` as Tool["address"]).pipe(
    Effect.mapError(
      (cause) =>
        new SemanticSearchError({
          message: `Failed to collect schema for AI Search item "${path}".`,
          cause,
        }),
    ),
    Effect.map((view) => {
      const sections = [
        `# ${path}`,
        `Name: ${name}`,
        `Integration: ${manifest.integration}`,
        manifest.connection ? `Connection: ${manifest.connection}` : undefined,
        manifest.pluginId ? `Plugin: ${manifest.pluginId}` : undefined,
        description ? `Description: ${description}` : undefined,
        view ? schemaSection("Input schema", view.inputSchema) : undefined,
        view ? schemaSection("Output schema", view.outputSchema) : undefined,
        view ? schemaSection("Definitions", view.schemaDefinitions) : undefined,
      ].filter((section): section is string => section !== undefined && section.length > 0);
      return {
        path,
        name,
        description,
        integration: manifest.integration,
        ...(manifest.connection ? { connection: manifest.connection } : {}),
        ...(manifest.pluginId ? { plugin: manifest.pluginId } : {}),
        fingerprint,
        content: truncateToAiSearchLimit(sections.join("\n\n")),
        metadata: {
          path,
          name,
          description: description.slice(0, 1_000),
          integration: manifest.integration,
          connection: manifest.connection ?? "",
        },
      };
    }),
  );
};
