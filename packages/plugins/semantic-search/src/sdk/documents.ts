import type { Executor, Tool } from "@executor-js/sdk/core";
import { Effect } from "effect";

import type { ToolDocumentInput } from "./chunker";
import { SemanticSearchError } from "./errors";
import { cyrb53, type FingerprintInput } from "./fingerprint";

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

  if (doc.inputTypeScript !== undefined) {
    parts.push(doc.inputTypeScript);
  }
  if (doc.outputTypeScript !== undefined) {
    parts.push(doc.outputTypeScript);
  }
  if (doc.typeScriptDefinitions !== undefined) {
    for (const def of Object.values(doc.typeScriptDefinitions)) {
      parts.push(def);
    }
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
  const sorted = [...tools].sort((a, b) => String(a.address).localeCompare(String(b.address)));
  const maxTools = options?.maxTools;
  if (maxTools === undefined) return sorted;
  const limit = Math.max(0, Math.floor(maxTools));
  if (limit >= sorted.length) return sorted;
  return [...sorted]
    .sort((a, b) => {
      const left = cyrb53(addressToPath(String(a.address)));
      const right = cyrb53(addressToPath(String(b.address)));
      return left === right ? String(a.address).localeCompare(String(b.address)) : left - right;
    })
    .slice(0, limit)
    .sort((a, b) => String(a.address).localeCompare(String(b.address)));
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

/** Collect `ToolDocumentInput` for a single tool descriptor.
 *
 *  Attempts to fetch its schema via `tools.schema(address)` to populate the
 *  TypeScript facets; on failure it degrades gracefully to an identity-only
 *  document.
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
      const doc: ToolDocumentInput =
        view === null
          ? base
          : {
              ...base,
              ...(view.inputTypeScript !== undefined
                ? { inputTypeScript: view.inputTypeScript }
                : {}),
              ...(view.outputTypeScript !== undefined
                ? { outputTypeScript: view.outputTypeScript }
                : {}),
              ...(view.typeScriptDefinitions !== undefined
                ? { typeScriptDefinitions: view.typeScriptDefinitions }
                : {}),
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

/** A tool paired with the raw-schema fingerprint input the diff hashes. */
export interface ToolFingerprintInput {
  readonly tool: IndexableToolDescriptor;
  readonly input: FingerprintInput;
}

/** Collect the cheap fingerprint inputs for a set of tools — the raw JSON schema
 *  (roots + referenced `$defs`), NO TypeScript codegen.
 *
 *  This is the cheap tier the incremental reindex diffs on: it fetches each
 *  tool's schema with `includeTypeScript: false`, so the CPU-heavy
 *  `tools.schema` codegen is skipped entirely. Only tools whose fingerprint
 *  changed go on to pay the codegen (via `collectDocsForTools`). On any per-tool
 *  schema-fetch failure we degrade to an identity-only fingerprint (path + name
 *  + description), which simply re-classifies the tool as "changed" and lets the
 *  full pass retry it — never failing the whole batch for one tool.
 *
 *  Bounded concurrency (16) keeps the walk fast while avoiding unbounded fan-out. */
export const collectFingerprintInputs = (
  executor: Executor,
  tools: readonly IndexableToolDescriptor[],
): Effect.Effect<readonly ToolFingerprintInput[], SemanticSearchError> =>
  Effect.forEach(
    tools,
    (tool) => {
      const base: FingerprintInput = {
        path: addressToPath(String(tool.address)),
        name: String(tool.name),
        description: stripHtml(String(tool.description ?? "")),
      };
      return executor.tools
        .schema(tool.address as Tool["address"], { includeTypeScript: false })
        .pipe(
          Effect.map((view): ToolFingerprintInput => {
            if (view === null) return { tool, input: base };
            return {
              tool,
              input: {
                ...base,
                ...(view.inputSchema !== undefined ? { inputSchema: view.inputSchema } : {}),
                ...(view.outputSchema !== undefined ? { outputSchema: view.outputSchema } : {}),
                ...(view.schemaDefinitions !== undefined
                  ? { schemaDefinitions: view.schemaDefinitions }
                  : {}),
              },
            };
          }),
          // Degrade: schema fetch failed — fall back to an identity-only fingerprint.
          Effect.catch(() => Effect.succeed<ToolFingerprintInput>({ tool, input: base })),
        );
    },
    { concurrency: 16 },
  );

/** Collect the full `ToolDocumentInput` set from the live catalog (list + schema).
 *  Convenience for non-paged callers; paged reindex uses `listToolDescriptors`
 *  to slice, then `collectDocsForTools` on each slice. */
export const collectToolDocumentInputs = (
  executor: Executor,
): Effect.Effect<readonly ToolDocumentInput[], SemanticSearchError> =>
  listToolDescriptors(executor).pipe(
    Effect.flatMap((tools) => collectDocsForTools(executor, tools)),
  );
