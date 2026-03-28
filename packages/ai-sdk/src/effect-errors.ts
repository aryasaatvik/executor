import * as Data from "effect/Data";

export class AiSdkEffectError extends Data.TaggedError(
  "AiSdkEffectError",
)<{
  readonly module: string;
  readonly message: string;
}> {}

export const aiSdkEffectError = (
  module: string,
  message: string,
) => new AiSdkEffectError({ module, message });
