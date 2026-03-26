import {
  EngineBadRequestError,
  EngineNotFoundError,
  EngineStorageError,
} from "../../api/errors";
import * as Effect from "effect/Effect";

export type OperationErrors<TOperation extends string = string> = {
  readonly operation: TOperation;
  readonly child: <TSuffix extends string>(
    suffix: TSuffix,
  ) => OperationErrors<`${TOperation}.${TSuffix}`>;
  readonly badRequest: (
    message: string,
    details: string,
  ) => EngineBadRequestError;
  readonly notFound: (
    message: string,
    details: string,
  ) => EngineNotFoundError;
  readonly storage: (
    error: Error,
  ) => EngineStorageError;
  readonly unknownStorage: (
    cause: unknown,
    details: string,
  ) => EngineStorageError;
  readonly mapStorage: <A, E extends Error>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, EngineStorageError>;
};

export type OperationErrorsLike = OperationErrors | string;

export const operationErrors = <TOperation extends string>(
  operation: TOperation,
): OperationErrors<TOperation> => {
  const self: OperationErrors<TOperation> = {
    operation,
    child: (suffix) =>
      operationErrors(`${operation}.${suffix}` as `${TOperation}.${typeof suffix}`),
    badRequest: (message, details) =>
      new EngineBadRequestError({
        operation,
        message,
        details,
      }),
    notFound: (message, details) =>
      new EngineNotFoundError({
        operation,
        message,
        details,
      }),
    storage: (error) =>
      new EngineStorageError({
        operation,
        message: error.message,
        details: error.message,
      }),
    unknownStorage: (cause, details) =>
      self.storage(
        cause instanceof Error
          ? new Error(`${cause.message}: ${details}`)
          : new Error(details),
      ),
    mapStorage: (effect) =>
      effect.pipe(
        Effect.mapError((error) => self.storage(error)),
      ),
  };

  return self;
};

export const asOperationErrors = (
  errors: OperationErrorsLike,
): OperationErrors =>
  typeof errors === "string"
    ? operationErrors(errors)
    : errors;
