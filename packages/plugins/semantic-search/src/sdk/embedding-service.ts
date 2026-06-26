import { Context, Layer } from "effect";

import { makeEmbedder, type MakeEmbedderOptions, type ToolEmbedder } from "./embedder";
import { makeHashEmbedder } from "./embedder-hash";

export class EmbedderService extends Context.Service<EmbedderService, ToolEmbedder>()(
  "@executor-js/plugin-semantic-search/EmbedderService",
) {}

export const embedderLayer = (options: MakeEmbedderOptions): Layer.Layer<EmbedderService> =>
  Layer.succeed(EmbedderService)(makeEmbedder(options));

export const hashEmbedderLayer = (dimensions?: number): Layer.Layer<EmbedderService> =>
  Layer.succeed(EmbedderService)(makeHashEmbedder(dimensions));
