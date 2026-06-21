import type { Executor, Tool, ToolSchemaManifest } from "@executor-js/sdk/core";
import { Effect } from "effect";

import type { ToolDocumentInput } from "./chunker";
import { SemanticSearchError } from "./errors";
import { cyrb53 } from "./fingerprint";

const ADDRESS_PREFIX = "tools.";

export interface IndexableToolDescriptor {
  readonly address: Tool["address"] | string;
  readonly name: Tool["name"] | string;
  readonly integration: Tool["integration"] | string;
  readonly description?: string;
}

// ---------------------------------------------------------------------------
// HTML-stripping helper
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags from a string, decode common HTML entities, and collapse
 * runs of whitespace to a single space.  Stripe (and other integrations)
 * sometimes embed raw `<p>…</p>` markup in tool descriptions; stripping them
 * gives clean text for both embedding and FTS indexing.
 */
export const stripHtml = (s: string): string =>
  s
    // Remove all HTML tags.
    .replace(/<[^>]*>/g, " ")
    // Decode the handful of entities that appear in practice.
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Collapse whitespace (including newlines introduced by the tag removal).
    .replace(/\s+/g, " ")
    .trim();

// ---------------------------------------------------------------------------
// Lexical-text builder
// ---------------------------------------------------------------------------

/**
 * Build a single broad text string for FTS indexing from a `ToolDocumentInput`.
 * Concatenates the most searchable fields in rough importance order:
 *   integration · path · name · clean description · key identifiers from schemas
 *
 * FTS5 already weights fields via BM25; this is the fallback `lexical_text`
 * column that carries identifiers and schema keywords not present in the
 * structured columns.
 */
export const buildLexicalText = (doc: ToolDocumentInput): string => {
  const parts: string[] = [doc.integration, doc.path, doc.name, stripHtml(doc.description)];

  if (doc.inputSchemaText !== undefined) {
    parts.push(doc.inputSchemaText);
  }
  if (doc.outputSchemaText !== undefined) {
    parts.push(doc.outputSchemaText);
  }
  if (doc.schemaDefinitionText !== undefined) {
    parts.push(doc.schemaDefinitionText);
  }

  return parts.join(" · ");
};

/** Strip the proxy-root `tools.` prefix so the address becomes the
 *  sandbox-callable path the model writes after `tools.` — mirrors the engine's
 *  own `addressToPath` so the `path` we index matches what `tools.search`
 *  callers expect (and can pass back to `describe`/invoke). */
export const addressToPath = (address: string): string =>
  address.startsWith(ADDRESS_PREFIX) ? address.slice(ADDRESS_PREFIX.length) : address;

export interface ListToolDescriptorsOptions {
  readonly maxTools?: number;
}

const selectToolDescriptors = (
  tools: readonly Tool[],
  options?: ListToolDescriptorsOptions,
): readonly Tool[] => {
  const maxTools = options?.maxTools;
  if (maxTools === undefined) {
    return [...tools].sort((a, b) => String(a.address).localeCompare(String(b.address)));
  }
  const limit = Math.max(0, Math.floor(maxTools));
  if (limit >= tools.length) {
    return [...tools].sort((a, b) => String(a.address).localeCompare(String(b.address)));
  }
  return [...tools]
    .sort((a, b) => {
      const left = cyrb53(addressToPath(String(a.address)));
      const right = cyrb53(addressToPath(String(b.address)));
      return left === right ? String(a.address).localeCompare(String(b.address)) : left - right;
    })
    .slice(0, limit)
    .sort((a, b) => String(a.address).localeCompare(String(b.address)));
};

const selectToolManifests = (
  manifests: readonly ToolSchemaManifest[],
  options?: ListToolDescriptorsOptions,
): readonly ToolSchemaManifest[] => {
  const maxTools = options?.maxTools;
  if (maxTools === undefined) {
    return [...manifests].sort((a, b) => a.path.localeCompare(b.path));
  }
  const limit = Math.max(0, Math.floor(maxTools));
  if (limit >= manifests.length) {
    return [...manifests].sort((a, b) => a.path.localeCompare(b.path));
  }
  return [...manifests]
    .sort((a, b) => {
      const left = cyrb53(a.path);
      const right = cyrb53(b.path);
      return left === right ? a.path.localeCompare(b.path) : left - right;
    })
    .slice(0, limit)
    .sort((a, b) => a.path.localeCompare(b.path));
};

/** List the live tool descriptors, stably sorted by address.
 *
 *  Cheap — descriptors only, NO per-tool schema fetch — so it is safe to call
 *  once per reindex page (to slice deterministically) and in the removal sweep
 *  (for liveness). The stable sort gives paged reindex consistent cursor indices
 *  even though `tools.list` has no native pagination. */
export const listToolDescriptors = (
  executor: Executor,
  options?: ListToolDescriptorsOptions,
): Effect.Effect<readonly Tool[], SemanticSearchError> =>
  executor.tools.list({ includeAnnotations: false }).pipe(
    Effect.mapError(
      (cause) => new SemanticSearchError({ message: "Failed to list tools for indexing.", cause }),
    ),
    Effect.map((tools) => selectToolDescriptors(tools, options)),
  );

/** List live tool schema manifests, stably sorted by indexed path.
 *
 *  This is the manifest tier for indexing: it carries precomputed raw-schema
 *  fingerprints from source refresh, so scan/diff can avoid per-tool
 *  `tools.schema` reads entirely. */
export const listToolManifests = (
  executor: Executor,
  options?: ListToolDescriptorsOptions,
): Effect.Effect<readonly ToolSchemaManifest[], SemanticSearchError> =>
  executor.tools.manifest().pipe(
    Effect.mapError(
      (cause) =>
        new SemanticSearchError({ message: "Failed to list tool manifests for indexing.", cause }),
    ),
    Effect.map((manifests) => selectToolManifests(manifests, options)),
  );

const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const collectSchemaTerms = (value: unknown, terms: Set<string>, depth = 0): void => {
  if (depth > 12 || terms.size >= 500) return;
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaTerms(item, terms, depth + 1);
    return;
  }
  if (!isPlainRecord(value)) return;

  for (const [key, entry] of Object.entries(value)) {
    if (terms.size >= 500) return;
    if (key === "properties" && isPlainRecord(entry)) {
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
        if (typeof item === "string" && item.length <= 80) terms.add(item);
      }
      continue;
    }
    if (key === "description" && typeof entry === "string") {
      const description = stripHtml(entry);
      if (description.length > 0) terms.add(description.slice(0, 240));
      continue;
    }
    collectSchemaTerms(entry, terms, depth + 1);
  }
};

const schemaFacetText = (label: string, schema: unknown): string | undefined => {
  const terms = new Set<string>();
  collectSchemaTerms(schema, terms);
  if (terms.size === 0) return undefined;
  return `${label} ${Array.from(terms).join(" ")}`;
};

const schemaDefinitionsFacetText = (
  definitions: Readonly<Record<string, unknown>> | undefined,
): string | undefined => {
  if (definitions === undefined || Object.keys(definitions).length === 0) return undefined;
  const terms = new Set<string>(Object.keys(definitions));
  for (const definition of Object.values(definitions)) collectSchemaTerms(definition, terms);
  return terms.size === 0 ? undefined : `definitions ${Array.from(terms).join(" ")}`;
};

/** Collect `ToolDocumentInput` for a single tool descriptor.
 *
 *  Fetches the tool's schema via `tools.schema(address)` to populate compact
 *  schema facets from the raw input/output schema + `$defs`. The TypeScript
 *  preview it also renders is unused here, but the call warms the shared
 *  schema-view cache the web UI reads on first open. On failure it degrades
 *  gracefully to an identity-only document.
 */
export const collectDocForTool = (
  executor: Executor,
  tool: IndexableToolDescriptor,
): Effect.Effect<ToolDocumentInput, SemanticSearchError> => {
  const path = addressToPath(String(tool.address));
  const base: ToolDocumentInput = {
    path,
    name: String(tool.name),
    integration: String(tool.integration),
    description: stripHtml(String(tool.description ?? "")),
  };
  return executor.tools.schema(tool.address as Tool["address"]).pipe(
    Effect.map((view): ToolDocumentInput => {
      if (view === null) return { ...base, lexicalText: buildLexicalText(base) };

      const inputSchemaText = schemaFacetText("input", view.inputSchema);
      const outputSchemaText = schemaFacetText("output", view.outputSchema);
      const schemaDefinitionText = schemaDefinitionsFacetText(view.schemaDefinitions);
      const doc: ToolDocumentInput = {
        ...base,
        ...(inputSchemaText !== undefined ? { inputSchemaText } : {}),
        ...(outputSchemaText !== undefined ? { outputSchemaText } : {}),
        ...(schemaDefinitionText !== undefined ? { schemaDefinitionText } : {}),
      };
      return { ...doc, lexicalText: buildLexicalText(doc) };
    }),
    // Degrade: schema fetch failed — use identity-only document.
    Effect.catch(() => Effect.succeed({ ...base, lexicalText: buildLexicalText(base) })),
  );
};

/** Collect `ToolDocumentInput` for a specific set of tool descriptors.
 *
 *  This per-tool schema → TypeScript codegen is the CPU-heavy part of indexing,
 *  so callers bound the input (one page) to stay within a single invocation's
 *  CPU budget.
 *
 *  Bounded concurrency (16) keeps the walk fast while avoiding unbounded fan-out. */
export const collectDocsForTools = (
  executor: Executor,
  tools: readonly IndexableToolDescriptor[],
): Effect.Effect<readonly ToolDocumentInput[], SemanticSearchError> =>
  Effect.forEach(tools, (tool) => collectDocForTool(executor, tool), { concurrency: 16 });

/** Collect the full `ToolDocumentInput` set from the live catalog (list + schema).
 *  Convenience for non-paged callers; the queued indexer uses manifests for
 *  scan/diff and only calls `collectDocForTool` for changed jobs. */
export const collectToolDocumentInputs = (
  executor: Executor,
): Effect.Effect<readonly ToolDocumentInput[], SemanticSearchError> =>
  listToolDescriptors(executor).pipe(
    Effect.flatMap((tools) => collectDocsForTools(executor, tools)),
  );
