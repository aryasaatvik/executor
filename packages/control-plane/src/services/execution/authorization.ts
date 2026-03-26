import { type ToolPath, makeToolInvokerFromTools } from "@executor/codemode-core";
import type { Source } from "../../model/index";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { LoadedSourceCatalogToolIndexEntry } from "./ir-execution";
import { invocationDescriptorFromTool } from "./ir-execution";
import { runtimeEffectError } from "./effect-errors";

// TODO: These engine-internal imports should be replaced with control-plane
// port interfaces once policy and workspace services are migrated.
// For now, define minimal placeholder types to allow compilation.

/** Placeholder for engine's SecretMaterialResolveContext */
export type SecretMaterialResolveContext = {
  params: Record<string, string>;
};

/** Placeholder for engine's WorkspaceStorageServices and WorkspaceDatabase */
type WorkspaceStorageServices = unknown;
type WorkspaceDatabase = unknown;

// TODO: Replace with control-plane policy service
type PolicyDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; reason: string };

type EvaluateInvocationPolicyFn = (input: {
  descriptor: ReturnType<typeof invocationDescriptorFromTool>;
  args: unknown;
  policies: unknown;
  context: { workspaceId: Source["workspaceId"] };
}) => PolicyDecision;

type LoadRuntimeLocalWorkspacePoliciesFn = (
  workspaceId: Source["workspaceId"],
) => Effect.Effect<{ policies: unknown }, unknown>;

// These will be injected from the engine during the transition period
let _evaluateInvocationPolicy: EvaluateInvocationPolicyFn | undefined;
let _loadRuntimeLocalWorkspacePolicies: LoadRuntimeLocalWorkspacePoliciesFn | undefined;

export const setPolicyResolver = (input: {
  evaluateInvocationPolicy: EvaluateInvocationPolicyFn;
  loadRuntimeLocalWorkspacePolicies: LoadRuntimeLocalWorkspacePoliciesFn;
}): void => {
  _evaluateInvocationPolicy = input.evaluateInvocationPolicy;
  _loadRuntimeLocalWorkspacePolicies = input.loadRuntimeLocalWorkspacePolicies;
};

const asToolPath = (value: string): ToolPath => value as ToolPath;

const approvalSchema = {
  type: "object",
  properties: {
    approve: {
      type: "boolean",
      description: "Whether to approve this tool execution",
    },
  },
  required: ["approve"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

const approvalMessageForInvocation = (
  descriptor: ReturnType<typeof invocationDescriptorFromTool>,
): string => {
  if (descriptor.approvalLabel) {
    return `Allow ${descriptor.approvalLabel}?`;
  }

  return `Allow tool call: ${descriptor.toolPath}?`;
};

const SecretResolutionContextEnvelopeSchema = Schema.Struct({
  params: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.String,
    }),
  ),
});

const decodeSecretResolutionContextEnvelope = Schema.decodeUnknownEither(
  SecretResolutionContextEnvelopeSchema,
);

export const toSecretResolutionContext = (
  value: unknown,
): SecretMaterialResolveContext | undefined => {
  const decoded = decodeSecretResolutionContextEnvelope(value);
  if (Either.isLeft(decoded) || decoded.right.params === undefined) {
    return undefined;
  }

  return {
    params: decoded.right.params,
  };
};

type WorkspaceToolElicitation = Parameters<
  typeof makeToolInvokerFromTools
>[0]["onElicitation"];

export const authorizePersistedToolInvocation = (input: {
  workspaceId: Source["workspaceId"];
  tool: LoadedSourceCatalogToolIndexEntry;
  args: unknown;
  context?: Record<string, unknown>;
  onElicitation?: WorkspaceToolElicitation;
}): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    if (!_evaluateInvocationPolicy || !_loadRuntimeLocalWorkspacePolicies) {
      // Policy resolver not configured — allow by default during migration
      return;
    }

    const descriptor = invocationDescriptorFromTool({
      tool: input.tool,
    });
    const localWorkspacePolicies = yield* _loadRuntimeLocalWorkspacePolicies(
      input.workspaceId,
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );

    const decision = _evaluateInvocationPolicy({
      descriptor,
      args: input.args,
      policies: localWorkspacePolicies.policies,
      context: {
        workspaceId: input.workspaceId,
      },
    });

    if (decision.kind === "allow") {
      return;
    }

    if (decision.kind === "deny") {
      return yield* runtimeEffectError("execution/workspace/authorization", decision.reason);
    }

    if (!input.onElicitation) {
      return yield* runtimeEffectError("execution/workspace/authorization",
          `Approval required for ${descriptor.toolPath}, but no elicitation-capable host is available`,
        );
    }

    const interactionId =
      typeof input.context?.callId === "string" &&
      input.context.callId.length > 0
        ? `tool_execution_gate:${input.context.callId}`
        : `tool_execution_gate:${crypto.randomUUID()}`;
    const response = yield* input
      .onElicitation({
        interactionId,
        path: asToolPath(descriptor.toolPath),
        sourceKey: input.tool.source.id,
        args: input.args,
        context: {
          ...input.context,
          interactionPurpose: "tool_execution_gate",
          interactionReason: decision.reason,
          invocationDescriptor: {
            operationKind: descriptor.operationKind,
            interaction: descriptor.interaction,
            approvalLabel: descriptor.approvalLabel,
            sourceId: input.tool.source.id,
            sourceName: input.tool.source.name,
          },
        },
        elicitation: {
          mode: "form",
          message: approvalMessageForInvocation(descriptor),
          requestedSchema: approvalSchema,
        },
      })
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
        ),
      );

    if (response.action !== "accept") {
      return yield* runtimeEffectError("execution/workspace/authorization",
          `Tool invocation not approved for ${descriptor.toolPath}`,
        );
    }
  });
