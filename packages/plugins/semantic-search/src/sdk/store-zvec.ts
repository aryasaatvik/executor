import { Effect } from "effect";

import { SemanticSearchError } from "./errors";
import type { VectorMatch, VectorStore, VectorInput } from "./store";

// ---------------------------------------------------------------------------
// zvec-backed VectorStore — a local, in-process, file-backed ANN index
// (@zvec/zvec, HNSW + cosine). A real local backend for developing + bench-
// marking the search logic without Cloudflare; the same `VectorStore` shape
// the production Vectorize binding satisfies.
//
// Two zvec specifics handled here:
//  - metadata is stored as one JSON `fields.metadataJson` (the seam carries
//    arbitrary metadata; zvec needs a fixed string schema), plus a `namespace`
//    field for post-filtering.
//  - zvec `score` is cosine DISTANCE (lower = nearer); we convert to a
//    similarity (`1 - distance`) so it matches Vectorize's higher-is-better.
//
// `@zvec/zvec` is a native addon loaded via dynamic import, so the plugin's
// Cloudflare build never pulls it in.
// ---------------------------------------------------------------------------

export interface ZVecStoreOptions {
  /** Collection directory on disk. */
  readonly path: string;
  readonly dimensions: number;
  /** Index type. "flat" = exact brute-force (lossless, fast for catalogs up to
   *  ~tens of thousands of vectors — the right default for tool search). "hnsw" =
   *  approximate ANN, only worth it past ~100k vectors (and can lose recall at
   *  small scale). Default "flat". */
  readonly index?: "flat" | "hnsw";
  readonly hnswM?: number;
  readonly hnswEfConstruction?: number;
  readonly hnswEf?: number;
}

interface ZVecQueryRow {
  readonly id: string;
  readonly score: number;
  readonly fields?: Record<string, unknown>;
}

interface ZVecCollection {
  upsertSync(docs: readonly unknown[]): unknown;
  querySync(input: unknown): readonly ZVecQueryRow[];
  deleteSync(ids: readonly string[]): unknown;
}

interface OpenedCollection {
  readonly coll: ZVecCollection;
  /** Query-time params for HNSW (indexType + ef); undefined for FLAT (exact —
   *  zvec rejects a FLAT indexType in QueryParams). */
  readonly queryParams: Record<string, unknown> | undefined;
}

const openCollection = async (options: ZVecStoreOptions): Promise<OpenedCollection> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- native addon, no shipped types
  const zvec = (await import("@zvec/zvec")) as any;
  const useHnsw = options.index === "hnsw";
  const indexParams = useHnsw
    ? {
        indexType: zvec.ZVecIndexType.HNSW,
        metricType: zvec.ZVecMetricType.COSINE,
        m: options.hnswM ?? 32,
        efConstruction: options.hnswEfConstruction ?? 200,
      }
    : {
        indexType: zvec.ZVecIndexType.FLAT,
        metricType: zvec.ZVecMetricType.COSINE,
      };
  const schema = new zvec.ZVecCollectionSchema({
    name: "vectors",
    vectors: {
      name: "embedding",
      dataType: zvec.ZVecDataType.VECTOR_FP32,
      dimension: options.dimensions,
      indexParams,
    },
    fields: [
      { name: "namespace", dataType: zvec.ZVecDataType.STRING },
      { name: "metadataJson", dataType: zvec.ZVecDataType.STRING },
    ],
  });
  let coll: ZVecCollection;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: @zvec/zvec native addon throws synchronously on open/create
  try {
    coll = zvec.ZVecOpen(options.path) as ZVecCollection;
  } catch {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: @zvec/zvec native addon throws synchronously on open/create
    try {
      coll = zvec.ZVecCreateAndOpen(options.path, schema) as ZVecCollection;
    } catch {
      coll = zvec.ZVecOpen(options.path) as ZVecCollection;
    }
  }
  return {
    coll,
    queryParams: useHnsw
      ? { indexType: zvec.ZVecIndexType.HNSW, ef: options.hnswEf ?? 128 }
      : undefined,
  };
};

const toMatches = (
  rows: readonly ZVecQueryRow[],
  namespace: string,
  topK: number,
): readonly VectorMatch[] => {
  const out: VectorMatch[] = [];
  for (const row of rows) {
    const ns = String(row.fields?.namespace ?? "");
    if (ns !== namespace) continue;
    let metadata: Record<string, unknown> | undefined;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: decoding zvec's stored metadataJson string
    try {
      // oxlint-disable-next-line executor/no-json-parse -- adapter boundary: decoding zvec's stored metadataJson string
      metadata = JSON.parse(String(row.fields?.metadataJson ?? "{}")) as Record<string, unknown>;
    } catch {
      metadata = undefined;
    }
    out.push({ id: row.id, score: 1 - row.score, namespace: ns, metadata });
    if (out.length >= topK) break;
  }
  return out;
};

export const makeZVecStore = (options: ZVecStoreOptions): VectorStore => {
  let cached: Promise<OpenedCollection> | null = null;
  const getCollection = Effect.tryPromise({
    try: () => (cached ??= openCollection(options)),
    catch: (cause) =>
      new SemanticSearchError({ message: `zvec open/create failed at ${options.path}.`, cause }),
  });

  return {
    // zvec/HNSW has no hard metadata-fetch cap — expose a generous limit.
    maxTopK: 200,
    upsert: (vectors: readonly VectorInput[]) =>
      vectors.length === 0
        ? Effect.void
        : getCollection.pipe(
            Effect.flatMap((opened) =>
              Effect.try({
                try: () =>
                  opened.coll.upsertSync(
                    vectors.map((v) => ({
                      id: v.id,
                      vectors: { embedding: [...v.values] },
                      fields: {
                        namespace: v.namespace ?? "",
                        metadataJson: JSON.stringify(v.metadata ?? {}),
                      },
                    })),
                  ),
                catch: (cause) =>
                  new SemanticSearchError({ message: "zvec upsert failed.", cause }),
              }),
            ),
            Effect.asVoid,
          ),

    query: ({ vector, namespace, topK }) =>
      getCollection.pipe(
        Effect.flatMap((opened) =>
          Effect.try({
            try: () =>
              opened.coll.querySync({
                fieldName: "embedding",
                vector: [...vector],
                // Over-fetch so the namespace post-filter still yields topK.
                topk: Math.max(topK * 4, 40),
                outputFields: ["namespace", "metadataJson"],
                // FLAT (exact) takes no query params; HNSW takes indexType + ef.
                ...(opened.queryParams ? { params: opened.queryParams } : {}),
              }),
            catch: (cause) => new SemanticSearchError({ message: "zvec query failed.", cause }),
          }).pipe(Effect.map((rows) => toMatches(rows, namespace, topK))),
        ),
      ),

    deleteByIds: (ids: readonly string[]) =>
      ids.length === 0
        ? Effect.void
        : getCollection.pipe(
            Effect.flatMap((opened) =>
              Effect.try({
                try: () => opened.coll.deleteSync([...ids]),
                catch: (cause) =>
                  new SemanticSearchError({ message: "zvec delete failed.", cause }),
              }),
            ),
            Effect.asVoid,
          ),
  };
};
