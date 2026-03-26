import * as Data from "effect/Data";

export class RuntimeEffectError extends Data.TaggedError(
  "RuntimeEffectError",
)<{
  readonly module: string;
  readonly message: string;
}> {}

export const runtimeEffectError = (
  module: string,
  message: string,
) => new RuntimeEffectError({ module, message });
