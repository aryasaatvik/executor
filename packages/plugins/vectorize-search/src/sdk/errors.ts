import { Data } from "effect";

/** A failure in the Vectorize search plugin's index or query path — an
 *  embedding call, the Vectorize binding, or a catalog read. The query path
 *  maps this into the engine's `ExecutionToolError` contract; the reindex path
 *  surfaces it directly. */
export class VectorizeSearchError extends Data.TaggedError("VectorizeSearchError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
