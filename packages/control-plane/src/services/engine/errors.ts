// API error classes — copied from @executor/engine/src/api/errors.ts
import { HttpApiSchema } from "@effect/platform";
import * as Schema from "effect/Schema";

export class EngineBadRequestError extends Schema.TaggedError<EngineBadRequestError>()(
  "EngineBadRequestError",
  {
    operation: Schema.String,
    message: Schema.String,
    details: Schema.String,
  },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class EngineNotFoundError extends Schema.TaggedError<EngineNotFoundError>()(
  "EngineNotFoundError",
  {
    operation: Schema.String,
    message: Schema.String,
    details: Schema.String,
  },
  HttpApiSchema.annotations({ status: 404 }),
) {}

export class EngineStorageError extends Schema.TaggedError<EngineStorageError>()(
  "EngineStorageError",
  {
    operation: Schema.String,
    message: Schema.String,
    details: Schema.String,
  },
  HttpApiSchema.annotations({ status: 500 }),
) {}

// Runtime effect error — copied from @executor/engine/src/runtime/effect-errors.ts
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
