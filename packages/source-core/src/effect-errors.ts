import * as Data from "effect/Data";

export class SourceCoreEffectError extends Data.TaggedError(
  "SourceCoreEffectError",
)<{
  readonly module: string;
  readonly message: string;
}> {}

export const sourceCoreEffectError = (
  module: string,
  message: string,
) => new SourceCoreEffectError({ module, message });
