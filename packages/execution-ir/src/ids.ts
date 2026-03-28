import { Schema } from "effect";

export const DocumentIdSchema = Schema.String.pipe(Schema.brand("DocumentId"));
export const ResourceIdSchema = Schema.String.pipe(Schema.brand("ResourceId"));
export const ScopeIdSchema = Schema.String.pipe(Schema.brand("ScopeId"));
export const CapabilityIdSchema = Schema.String.pipe(Schema.brand("CapabilityId"));
export const ExecutableIdSchema = Schema.String.pipe(Schema.brand("ExecutableId"));
export const ResponseSetIdSchema = Schema.String.pipe(Schema.brand("ResponseSetId"));
export const DiagnosticIdSchema = Schema.String.pipe(Schema.brand("DiagnosticId"));

export const ShapeSymbolIdSchema = Schema.String.pipe(Schema.brand("ShapeSymbolId"));
export const ParameterSymbolIdSchema = Schema.String.pipe(Schema.brand("ParameterSymbolId"));
export const RequestBodySymbolIdSchema = Schema.String.pipe(
  Schema.brand("RequestBodySymbolId"),
);
export const ResponseSymbolIdSchema = Schema.String.pipe(
  Schema.brand("ResponseSymbolId"),
);
export const HeaderSymbolIdSchema = Schema.String.pipe(Schema.brand("HeaderSymbolId"));
export const ExampleSymbolIdSchema = Schema.String.pipe(Schema.brand("ExampleSymbolId"));
export const SecuritySchemeSymbolIdSchema = Schema.String.pipe(
  Schema.brand("SecuritySchemeSymbolId"),
);

export type DocumentId = typeof DocumentIdSchema.Type;
export type ResourceId = typeof ResourceIdSchema.Type;
export type ScopeId = typeof ScopeIdSchema.Type;
export type CapabilityId = typeof CapabilityIdSchema.Type;
export type ExecutableId = typeof ExecutableIdSchema.Type;
export type ResponseSetId = typeof ResponseSetIdSchema.Type;
export type DiagnosticId = typeof DiagnosticIdSchema.Type;

export type ShapeSymbolId = typeof ShapeSymbolIdSchema.Type;
export type ParameterSymbolId = typeof ParameterSymbolIdSchema.Type;
export type RequestBodySymbolId = typeof RequestBodySymbolIdSchema.Type;
export type ResponseSymbolId = typeof ResponseSymbolIdSchema.Type;
export type HeaderSymbolId = typeof HeaderSymbolIdSchema.Type;
export type ExampleSymbolId = typeof ExampleSymbolIdSchema.Type;
export type SecuritySchemeSymbolId = typeof SecuritySchemeSymbolIdSchema.Type;

export type SymbolId =
  | ShapeSymbolId
  | ParameterSymbolId
  | RequestBodySymbolId
  | ResponseSymbolId
  | HeaderSymbolId
  | ExampleSymbolId
  | SecuritySchemeSymbolId;

export const SymbolIdSchema = Schema.Union(
  ShapeSymbolIdSchema,
  ParameterSymbolIdSchema,
  RequestBodySymbolIdSchema,
  ResponseSymbolIdSchema,
  HeaderSymbolIdSchema,
  ExampleSymbolIdSchema,
  SecuritySchemeSymbolIdSchema,
);
