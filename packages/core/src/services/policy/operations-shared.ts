import {
  EngineBadRequestError,
  EngineStorageError,
} from "../engine/errors";
import * as Effect from "effect/Effect";

import {
  asOperationErrors,
  type OperationErrorsLike,
} from "./operation-errors";
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export const mapPersistenceError = <A, R>(
  operation: OperationErrorsLike,
  effect: Effect.Effect<A, Error, R>,
): Effect.Effect<A, EngineBadRequestError | EngineStorageError, R> =>
  effect.pipe(
    Effect.mapError((error) => {
      const errors = asOperationErrors(operation);
      return errors.storage(error);
    }),
  );

export const parseJsonString = (
  operation: OperationErrorsLike,
  fieldName: string,
  value: string,
): Effect.Effect<string, EngineBadRequestError> =>
  Effect.try({
    try: () => {
      JSON.parse(value);
      return value;
    },
    catch: () => {
      const errors = asOperationErrors(operation);
      return errors.badRequest(
        `Invalid ${fieldName}`,
        `${fieldName} must be valid JSON`,
      );
    },
  });
