import * as Effect from "effect/Effect"

import { VecService } from "./vec"

export const removeSourceEmbeddings = (sourceKey: string) =>
  Effect.gen(function* () {
    const vec = yield* VecService
    yield* vec.removeVecSourceTools(sourceKey)
  })
