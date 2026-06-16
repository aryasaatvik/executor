import type { Executor } from "@executor-js/sdk/core";
import { Effect } from "effect";

import type { ToolDocumentInput } from "./chunker";
import { SemanticSearchError } from "./errors";

const ADDRESS_PREFIX = "tools.";

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

/** Collect the full `ToolDocumentInput` set from the live catalog.
 *
 *  For each tool returned by `tools.list`, we attempt to fetch its schema via
 *  `tools.schema(address)` to populate the TypeScript facets (inputTypeScript,
 *  outputTypeScript, typeScriptDefinitions). If the schema fetch fails for any
 *  individual tool we degrade gracefully to an identity-only document (no TS
 *  fields) — never failing the whole collection for one tool.
 *
 *  Bounded concurrency (16) keeps the catalog walk fast while avoiding
 *  unbounded fan-out. */
export const collectToolDocumentInputs = (
  namespace: string,
  executor: Executor,
): Effect.Effect<readonly ToolDocumentInput[], SemanticSearchError> =>
  executor.tools.list({ includeAnnotations: false }).pipe(
    Effect.mapError(
      (cause) => new SemanticSearchError({ message: "Failed to list tools for indexing.", cause }),
    ),
    Effect.flatMap((tools) =>
      Effect.forEach(
        tools,
        (tool) => {
          const path = addressToPath(String(tool.address));
          const base: ToolDocumentInput = {
            path,
            name: String(tool.name),
            integration: String(tool.integration),
            description: stripHtml(String(tool.description ?? "")),
          };
          // Attempt schema fetch; on any failure degrade to identity-only.
          return executor.tools.schema(tool.address).pipe(
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
        },
        { concurrency: 16 },
      ),
    ),
  );
