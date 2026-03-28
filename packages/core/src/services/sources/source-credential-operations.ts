import type {
  ExecutionEnvelope,
  ExecutionInteraction,
  Source,
  WorkspaceId,
} from "../../model";
import {
  SourceIdSchema,
  WorkspaceIdSchema,
} from "../../model";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  createSourceCredentialSelectionBearerContent,
  createSourceCredentialSelectionNoneContent,
} from "./source-credential-interactions";
import { submitExecutionInteractionResponse } from "../execution";
import { ExecutionManager } from "../execution";
import { operationErrors } from "../policy/operation-errors";
import { SourceAuthService } from "./source-auth-service";
import { EngineStore } from "../engine/store";

const sourceCredentialOps = {
  complete: operationErrors("sources.credentials.complete"),
  page: operationErrors("sources.credentials.page"),
  submit: operationErrors("sources.credentials.submit"),
} as const;

type SourceCredentialInteraction = {
  interactionId: ExecutionInteraction["id"];
  executionId: ExecutionEnvelope["execution"]["id"];
  status: ExecutionInteraction["status"];
  message: string;
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
  sourceLabel: string;
  endpoint: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const trimOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const decodeSourceCredentialInteraction = (
  interaction: ExecutionInteraction,
): Omit<SourceCredentialInteraction, "sourceLabel" | "endpoint"> | null => {
  try {
    if (
      interaction.purpose !== "source_connect_oauth2"
      && interaction.purpose !== "source_connect_secret"
      && interaction.purpose !== "elicitation"
    ) {
      return null;
    }

    const payload = JSON.parse(interaction.payloadJson) as unknown;
    if (!isRecord(payload)) {
      return null;
    }

    const args = payload.args;
    const elicitation = payload.elicitation;
    if (!isRecord(args) || !isRecord(elicitation)) {
      return null;
    }

    if (payload.path !== "executor.sources.add" || args.kind !== "openapi") {
      return null;
    }

    const effectivePurpose = interaction.purpose === "elicitation"
      ? elicitation.mode === "url"
        ? "source_connect_oauth2"
        : "source_connect_secret"
      : interaction.purpose;

    if (effectivePurpose === "source_connect_oauth2" && elicitation.mode !== "url") {
      return null;
    }

    if (effectivePurpose === "source_connect_secret" && elicitation.mode !== "form") {
      return null;
    }

    const workspaceId = trimOrNull(asString(args.workspaceId));
    const sourceId = trimOrNull(asString(args.sourceId));
    const message = trimOrNull(asString(elicitation.message));
    if (workspaceId === null || sourceId === null || message === null) {
      return null;
    }

    return {
      interactionId: interaction.id,
      executionId: interaction.executionId,
      status: interaction.status,
      message,
      workspaceId: WorkspaceIdSchema.make(workspaceId),
      sourceId: SourceIdSchema.make(sourceId),
    };
  } catch {
    return null;
  }
};

const loadSourceCredentialInteraction = (input: {
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
  interactionId: ExecutionInteraction["id"];
  operation:
    | typeof sourceCredentialOps.page
    | typeof sourceCredentialOps.submit;
}) =>
  Effect.gen(function* () {
    const store = yield* EngineStore;
    const sourceAuthService = yield* SourceAuthService;

    const stored = yield* store.executionInteractions.getById(input.interactionId).pipe(
      Effect.mapError((error) =>
        input.operation.unknownStorage(
          error,
          `Failed loading execution interaction ${input.interactionId}`,
        ),
      ),
    );

    if (Option.isNone(stored)) {
      return yield* input.operation.notFound(
        "Source credential request not found",
        `interactionId=${input.interactionId}`,
      );
    }

    const decoded = decodeSourceCredentialInteraction(stored.value);
    if (
      decoded === null
      || decoded.workspaceId !== input.workspaceId
      || decoded.sourceId !== input.sourceId
    ) {
      return yield* input.operation.notFound(
        "Source credential request not found",
        `workspaceId=${input.workspaceId} sourceId=${input.sourceId} interactionId=${input.interactionId}`,
      );
    }

    const source = yield* sourceAuthService.getSourceById({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
    }).pipe(
      Effect.mapError((error) =>
        input.operation.unknownStorage(
          error,
          `Failed loading source ${input.sourceId}`,
        ),
      ),
    );

    return {
      ...decoded,
      sourceLabel: source.name,
      endpoint: source.endpoint,
    } satisfies SourceCredentialInteraction;
  });

export const getSourceCredentialInteraction = (input: {
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
  interactionId: ExecutionInteraction["id"];
}) =>
  loadSourceCredentialInteraction({
    ...input,
    operation: sourceCredentialOps.page,
  });

export const submitSourceCredentialInteraction = (input: {
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
  interactionId: ExecutionInteraction["id"];
  action: "submit" | "continue" | "cancel";
  token?: string | null;
}) =>
  Effect.gen(function* () {
    const interaction = yield* loadSourceCredentialInteraction({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      interactionId: input.interactionId,
      operation: sourceCredentialOps.submit,
    });

    if (interaction.status !== "pending") {
      return yield* sourceCredentialOps.submit.badRequest(
        "Source credential request is no longer active",
        `interactionId=${interaction.interactionId} status=${interaction.status}`,
      );
    }

    const liveExecutionManager = yield* ExecutionManager;

    if (input.action === "cancel") {
      const resumed = yield* liveExecutionManager.resolveInteraction({
        executionId: interaction.executionId,
        response: { action: "cancel" },
      });

      if (!resumed) {
        const persisted = yield* submitExecutionInteractionResponse({
          workspaceId: interaction.workspaceId,
          executionId: interaction.executionId,
          response: { action: "cancel" },
        }).pipe(
          Effect.mapError((error) =>
            sourceCredentialOps.submit.unknownStorage(
              error,
              `Failed resuming execution for interaction ${interaction.interactionId}`,
            ),
          ),
        );

        if (!persisted) {
          return yield* sourceCredentialOps.submit.badRequest(
            "Source credential request is no longer resumable",
            `interactionId=${interaction.interactionId}`,
          );
        }
      }

      return {
        kind: "cancelled" as const,
        sourceLabel: interaction.sourceLabel,
        endpoint: interaction.endpoint,
      };
    }

    if (input.action === "continue") {
      const continuedContent = createSourceCredentialSelectionNoneContent();
      const resumed = yield* liveExecutionManager.resolveInteraction({
        executionId: interaction.executionId,
        response: {
          action: "accept",
          content: continuedContent,
        },
      });

      if (!resumed) {
        const persisted = yield* submitExecutionInteractionResponse({
          workspaceId: interaction.workspaceId,
          executionId: interaction.executionId,
          response: {
            action: "accept",
            content: continuedContent,
          },
        }).pipe(
          Effect.mapError((error) =>
            sourceCredentialOps.submit.unknownStorage(
              error,
              `Failed resuming execution for interaction ${interaction.interactionId}`,
            ),
          ),
        );

        if (!persisted) {
          return yield* sourceCredentialOps.submit.badRequest(
            "Source credential request is no longer resumable",
            `interactionId=${interaction.interactionId}`,
          );
        }
      }

      return {
        kind: "continued" as const,
        sourceLabel: interaction.sourceLabel,
        endpoint: interaction.endpoint,
      };
    }

    const token = trimOrNull(input.token);
    if (token === null) {
      return yield* sourceCredentialOps.submit.badRequest(
        "Missing token",
        `interactionId=${interaction.interactionId}`,
      );
    }

    const sourceAuthService = yield* SourceAuthService;
    const tokenRef = yield* sourceAuthService.storeSecretMaterial({
      purpose: "auth_material",
      value: token,
    }).pipe(
      Effect.mapError((error) =>
        sourceCredentialOps.submit.unknownStorage(
          error,
          `Failed storing credential material for interaction ${interaction.interactionId}`,
        ),
      ),
    );

    const storedContent = createSourceCredentialSelectionBearerContent(tokenRef);
    const resumed = yield* liveExecutionManager.resolveInteraction({
      executionId: interaction.executionId,
      response: {
        action: "accept",
        content: storedContent,
      },
    });

    if (!resumed) {
      const persisted = yield* submitExecutionInteractionResponse({
        workspaceId: interaction.workspaceId,
        executionId: interaction.executionId,
        response: {
          action: "accept",
          content: storedContent,
        },
      }).pipe(
        Effect.mapError((error) =>
          sourceCredentialOps.submit.unknownStorage(
            error,
            `Failed resuming execution for interaction ${interaction.interactionId}`,
          ),
        ),
      );

      if (!persisted) {
        return yield* sourceCredentialOps.submit.badRequest(
          "Source credential request is no longer resumable",
          `interactionId=${interaction.interactionId}`,
        );
      }
    }

    return {
      kind: "stored" as const,
      sourceLabel: interaction.sourceLabel,
      endpoint: interaction.endpoint,
    };
  });

export const completeSourceCredentialSetup = (input: {
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
  state: string;
  code?: string | null;
  error?: string | null;
  errorDescription?: string | null;
}) =>
  Effect.gen(function* () {
    const sourceAuthService = yield* SourceAuthService;

    return yield* sourceAuthService.completeSourceCredentialSetup(input).pipe(
      Effect.mapError((error) =>
        sourceCredentialOps.complete.unknownStorage(
          error,
          "Failed completing source credential setup",
        ),
      ),
    );
  });
