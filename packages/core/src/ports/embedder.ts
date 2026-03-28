import { Context, Effect } from "effect";

export interface EmbedderShape {
  /** Generate an embedding for a single text */
  readonly embed: (text: string) => Effect.Effect<ReadonlyArray<number>>;

  /** Batch embed multiple texts */
  readonly embedBatch: (
    texts: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<number>>>;

  /** Number of dimensions produced by this embedder */
  readonly dimensions: number;
}

export class Embedder extends Context.Tag("@executor/core/Embedder")<
  Embedder,
  EmbedderShape
>() {}
