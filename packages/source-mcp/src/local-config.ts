import * as Schema from "effect/Schema";

import {
  SourceTransportSchema,
  StringArraySchema,
  StringMapSchema,
} from "@executor/source-core";

export const McpLocalConfigBindingSchema = Schema.Struct({
  transport: Schema.optional(Schema.NullOr(SourceTransportSchema)),
  queryParams: Schema.optional(Schema.NullOr(StringMapSchema)),
  headers: Schema.optional(Schema.NullOr(StringMapSchema)),
  command: Schema.optional(Schema.NullOr(Schema.String)),
  args: Schema.optional(Schema.NullOr(StringArraySchema)),
  env: Schema.optional(Schema.NullOr(StringMapSchema)),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
});
