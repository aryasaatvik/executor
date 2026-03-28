import * as Data from "effect/Data";

export class KitchenSinkEffectError extends Data.TaggedError(
  "KitchenSinkEffectError",
)<{
  readonly module: string;
  readonly message: string;
}> {}

export const kitchenSinkEffectError = (
  module: string,
  message: string,
) => new KitchenSinkEffectError({ module, message });
