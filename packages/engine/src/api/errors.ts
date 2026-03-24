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

export class EngineUnauthorizedError extends Schema.TaggedError<EngineUnauthorizedError>()(
  "EngineUnauthorizedError",
  {
    operation: Schema.String,
    message: Schema.String,
    details: Schema.String,
  },
  HttpApiSchema.annotations({ status: 401 }),
) {}

export class EngineForbiddenError extends Schema.TaggedError<EngineForbiddenError>()(
  "EngineForbiddenError",
  {
    operation: Schema.String,
    message: Schema.String,
    details: Schema.String,
  },
  HttpApiSchema.annotations({ status: 403 }),
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
