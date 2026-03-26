import * as Data from "effect/Data";

export class PlatformServerEffectError extends Data.TaggedError(
  "PlatformServerEffectError",
)<{
  readonly module: string;
  readonly message: string;
}> {}

export const platformServerEffectError = (
  module: string,
  message: string,
) => new PlatformServerEffectError({ module, message });
