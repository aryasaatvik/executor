// ---------------------------------------------------------------------------
// Deterministic content hash over the fields that define a tool's semantic
// identity. Used by the incremental reindex to detect changes and skip
// unchanged tools.
//
// The hash keys off the RAW JSON schema (input/output roots + the referenced
// `$defs`), NOT the generated TypeScript. The TS is a deterministic function of
// the raw schema, so hashing the raw schema is change-equivalent — but the raw
// schema is read cheaply from the tool row, whereas the TS costs the per-tool
// codegen. That lets the reindex decide "unchanged" without codegen, and pay it
// only for tools that actually changed. Referenced `$defs` are included so a
// change to a shared definition a tool `$ref`s still flips the fingerprint.
// ---------------------------------------------------------------------------

export interface FingerprintInput {
  readonly path: string;
  readonly name: string;
  readonly description?: string;
  /** Raw input JSON schema root (the `tool` row column, not the codegen). */
  readonly inputSchema?: unknown;
  /** Raw output JSON schema root. */
  readonly outputSchema?: unknown;
  /** Referenced `$defs` the input/output schemas resolve against. */
  readonly schemaDefinitions?: Record<string, unknown>;
}

// Canonical JSON: object keys sorted, `undefined` dropped, arrays preserved.
// JSON.stringify is key-insertion-ordered, so two schemas that differ only in
// key order would hash differently; canonicalizing first avoids those false
// "changed" verdicts (and the needless re-embed they would trigger).
const canonicalize = (value: unknown): string => {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
};

// cyrb53 — a fast, stable 53-bit hash with good avalanche properties.
// Produces a consistent unsigned integer across all JS environments.
// Source: https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js
export function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// Field separator: the NUL byte cannot appear in TypeScript source or
// natural-language text, so adjacent field values can never blur across the
// boundary. A space separator would let e.g. {name:"a b"} and
// {name:"a", description:"b"} hash to the same value.
const FIELD_SEPARATOR = String.fromCharCode(0);

/** Stable, deterministic fingerprint over a tool's identity + raw schema.
 *  Changes when ANY field changes and is identical for identical input. */
export const fingerprintTool = (input: FingerprintInput): string => {
  const content = [
    input.path,
    input.name,
    input.description ?? "",
    canonicalize(input.inputSchema),
    canonicalize(input.outputSchema),
    canonicalize(input.schemaDefinitions),
  ].join(FIELD_SEPARATOR);
  return cyrb53(content).toString(36);
};
