// ---------------------------------------------------------------------------
// Facet-aware chunker (P1). A tool becomes one OR MORE chunks, each targeting
// a distinct semantic facet: identity (header + description lead), description
// continuation paragraphs, input schema, and output schema.
//
// Design goals:
//   - Structure-aware splitting: paragraph → sentence → hard-cap (almost never).
//     No fixed char windows; chunks always end on coherent text boundaries.
//   - Schema-less tools degrade cleanly to a single identity chunk.
//   - Hashed ids keep every id ≤ 64 bytes (Vectorize hard cap).
//   - makeWholeChunker() mirrors the pre-facet documents.ts behavior for
//     benchmarking / regression comparisons.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// cyrb53 — deterministic 53-bit hash, dependency-free. Copied locally so
// chunker.ts has no import dependency on the old chunking.ts.
// ---------------------------------------------------------------------------
const cyrb53 = (str: string): string => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The input representation of a tool used by the chunker — richer than the
 *  core Tool contract, because it includes the schema strings produced by
 *  tools.schema(). */
export interface ToolDocumentInput {
  readonly path: string;
  readonly name: string;
  readonly integration: string;
  readonly description: string;
  readonly inputTypeScript?: string;
  readonly outputTypeScript?: string;
  readonly typeScriptDefinitions?: Record<string, string>;
  /**
   * Broad single-string representation of the tool for FTS indexing.
   * Populated by the projector (`buildLexicalText` in documents.ts); absent
   * when the input comes from a source that does not populate it.
   */
  readonly lexicalText?: string;
}

/** Which semantic facet a chunk represents. */
export type ChunkFacet = "identity" | "description" | "input" | "output";

/** A single embeddable unit of a tool, carrying the facet tag and a stable
 *  hashed id that is guaranteed to be ≤ 64 bytes. */
export interface ToolChunk {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly integration: string;
  readonly facet: ChunkFacet;
  readonly chunkIndex: number;
  readonly embeddingText: string;
}

/** The chunker contract. The namespace is the logical partition key (matches the
 *  Vectorize namespace) and is baked into each chunk id so ids are globally
 *  unique across namespaces. */
export interface Chunker {
  readonly chunk: (namespace: string, doc: ToolDocumentInput) => readonly ToolChunk[];
}

/** Options for the facet chunker. */
export interface FacetChunkerOptions {
  /** Per-facet character budget (~4 chars/token). Default ≈ 1600 (400 tokens). */
  readonly facetCharBudget?: number;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const DEFAULT_FACET_CHAR_BUDGET = 1600;

// Sentence-boundary regex: split after . ! ? followed by whitespace or end.
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/;

// Paragraph boundary: one or more blank lines.
const PARAGRAPH_BOUNDARY = /\n\s*\n/;

// A "trivial" schema string contributes nothing useful to the embedding.
const isTrivialSchema = (ts: string | undefined): ts is undefined => {
  if (ts === undefined) return true;
  const trimmed = ts.trim();
  return (
    trimmed.length === 0 ||
    trimmed === "{}" ||
    trimmed === "void" ||
    trimmed === "undefined" ||
    trimmed === "null" ||
    trimmed === "unknown"
  );
};

// ---------------------------------------------------------------------------
// Chunk-id factory
// ---------------------------------------------------------------------------

/** `t_${cyrb53(namespace#path#facet#index)}` — always ≤ 64 bytes. */
const makeId = (namespace: string, path: string, facet: ChunkFacet, chunkIndex: number): string =>
  `t_${cyrb53(`${namespace}#${path}#${facet}#${chunkIndex}`)}`;

// ---------------------------------------------------------------------------
// Structure-aware splitting
// ---------------------------------------------------------------------------

/** Extract the first paragraph ("lead") from text. Returns `[lead, remainder]`.
 *  The lead never includes the blank-line separator. */
const splitLead = (text: string): [string, string] => {
  const match = text.search(PARAGRAPH_BOUNDARY);
  if (match === -1) return [text.trim(), ""];
  return [text.slice(0, match).trim(), text.slice(match).trim()];
};

/** Split `text` into pieces each ≤ `budget` characters, respecting structure:
 *  paragraphs first, then sentences, then hard-cap as a last resort.
 *  Adjacent paragraphs are greedily grouped up to `budget`. */
const recursiveSplit = (text: string, budget: number): readonly string[] => {
  if (text.length === 0) return [];
  if (text.length <= budget) return [text];

  // --- paragraph split ---
  const rawParagraphs = text
    .split(PARAGRAPH_BOUNDARY)
    .map((p) => p.trim())
    .filter(Boolean);
  if (rawParagraphs.length > 1) {
    // Greedily group adjacent paragraphs up to budget.
    const groups: string[] = [];
    let current = "";
    for (const para of rawParagraphs) {
      const candidate = current.length === 0 ? para : `${current}\n\n${para}`;
      if (candidate.length <= budget) {
        current = candidate;
      } else {
        if (current.length > 0) groups.push(current);
        // The paragraph itself may exceed the budget — recurse into it.
        if (para.length > budget) {
          groups.push(...recursiveSplit(para, budget));
          current = "";
        } else {
          current = para;
        }
      }
    }
    if (current.length > 0) groups.push(current);
    return groups;
  }

  // --- sentence split ---
  const sentences = text
    .split(SENTENCE_BOUNDARY)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length > 1) {
    const groups: string[] = [];
    let current = "";
    for (const sentence of sentences) {
      const candidate = current.length === 0 ? sentence : `${current} ${sentence}`;
      if (candidate.length <= budget) {
        current = candidate;
      } else {
        if (current.length > 0) groups.push(current);
        if (sentence.length > budget) {
          // Hard-cap last resort: slice at budget.
          groups.push(...hardSlice(sentence, budget));
          current = "";
        } else {
          current = sentence;
        }
      }
    }
    if (current.length > 0) groups.push(current);
    return groups;
  }

  // --- hard-cap last resort ---
  return hardSlice(text, budget);
};

const hardSlice = (text: string, budget: number): readonly string[] => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += budget) {
    out.push(text.slice(i, i + budget));
  }
  return out;
};

// ---------------------------------------------------------------------------
// makeFacetChunker
// ---------------------------------------------------------------------------

export const makeFacetChunker = (options?: FacetChunkerOptions): Chunker => {
  const budget = Math.max(1, options?.facetCharBudget ?? DEFAULT_FACET_CHAR_BUDGET);

  return {
    chunk(namespace, doc) {
      const { path, name, integration, description } = doc;
      const chunks: ToolChunk[] = [];

      // -----------------------------------------------------------------------
      // Identity facet (chunkIndex 0, always present)
      // -----------------------------------------------------------------------
      const header = `${integration} ${path}\n${name}`;
      const [lead, remainder] = splitLead(description.trim());

      // Budget remaining after the header for the lead.
      const headerLen = header.length + (lead.length > 0 ? 1 : 0); // +1 for '\n'
      const leadBudget = Math.max(0, budget - headerLen);
      const clippedLead = lead.slice(0, leadBudget); // Trim lead to budget; it rarely exceeds it.
      const identityText = clippedLead.length > 0 ? `${header}\n${clippedLead}` : header;

      let globalIndex = 0;
      chunks.push({
        id: makeId(namespace, path, "identity", globalIndex),
        path,
        name,
        integration,
        facet: "identity",
        chunkIndex: globalIndex,
        embeddingText: identityText,
      });
      globalIndex++;

      // -----------------------------------------------------------------------
      // Description facets (remainder split by structure)
      // -----------------------------------------------------------------------
      if (remainder.length > 0) {
        const pieces = recursiveSplit(remainder, budget);
        for (const piece of pieces) {
          if (piece.trim().length === 0) continue;
          chunks.push({
            id: makeId(namespace, path, "description", globalIndex),
            path,
            name,
            integration,
            facet: "description",
            chunkIndex: globalIndex,
            embeddingText: piece.trim(),
          });
          globalIndex++;
        }
      }

      // -----------------------------------------------------------------------
      // Input facet
      // -----------------------------------------------------------------------
      if (!isTrivialSchema(doc.inputTypeScript)) {
        const text = `${integration} ${path} input\n${doc.inputTypeScript}`;
        // If the schema exceeds the budget, keep the structural head (entire
        // text is preferable; hard-slicing is safer than silently losing it).
        const embeddingText = text.length <= budget ? text : text.slice(0, budget);
        chunks.push({
          id: makeId(namespace, path, "input", globalIndex),
          path,
          name,
          integration,
          facet: "input",
          chunkIndex: globalIndex,
          embeddingText,
        });
        globalIndex++;
      }

      // -----------------------------------------------------------------------
      // Output facet
      // -----------------------------------------------------------------------
      if (!isTrivialSchema(doc.outputTypeScript)) {
        const text = `${integration} ${path} output\n${doc.outputTypeScript}`;
        const embeddingText = text.length <= budget ? text : text.slice(0, budget);
        chunks.push({
          id: makeId(namespace, path, "output", globalIndex),
          path,
          name,
          integration,
          facet: "output",
          chunkIndex: globalIndex,
          embeddingText,
        });
        globalIndex++;
      }

      return chunks;
    },
  };
};

// ---------------------------------------------------------------------------
// makeWholeChunker — benchmark baseline (mirrors pre-P1 documents.ts behavior)
// ---------------------------------------------------------------------------

/** Produces a single identity chunk per tool with the full description joined.
 *  Used as a search-quality baseline to compare against the facet chunker. */
export const makeWholeChunker = (): Chunker => ({
  chunk(namespace, doc) {
    const { path, name, integration, description } = doc;
    const header = `${integration} ${path}\n${name}`;
    const embeddingText =
      description.trim().length > 0 ? `${header}\n${description.trim()}` : header;
    return [
      {
        id: makeId(namespace, path, "identity", 0),
        path,
        name,
        integration,
        facet: "identity",
        chunkIndex: 0,
        embeddingText,
      },
    ];
  },
});
