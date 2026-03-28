import * as Schema from "effect/Schema";

export const TrimmedNonEmptyStringSchema = Schema.Trim.pipe(
  Schema.nonEmptyString(),
);

export const OptionalTrimmedNonEmptyStringSchema = Schema.optional(
  TrimmedNonEmptyStringSchema,
);
