import { Data } from "effect";

/** A failure in the Semantic search plugin's index or query path: an
 *  AI Search call, document projection, or catalog read. The query path
 *  maps this into the engine's `ExecutionToolError` contract; the reindex path
 *  surfaces it directly. */
export class SemanticSearchError extends Data.TaggedError("SemanticSearchError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
