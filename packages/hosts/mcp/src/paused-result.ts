import type {
  ExecutionEnvelope,
  ExecutionInteraction,
} from "@executor/engine";

export type ParsedInteractionPayload = {
  mode: "form" | "url";
  message: string;
  url?: string;
  requestedSchema?: Record<string, unknown>;
  elicitationId?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseInteractionPayload = (
  interaction: ExecutionInteraction,
): ParsedInteractionPayload | null => {
  try {
    const parsed = JSON.parse(interaction.payloadJson) as {
      elicitation?: {
        mode?: "form" | "url";
        message?: string;
        url?: string;
        requestedSchema?: Record<string, unknown>;
        elicitationId?: string;
        id?: string;
      };
    };

    if (!parsed.elicitation || typeof parsed.elicitation.message !== "string") {
      return null;
    }

    return {
      mode: parsed.elicitation.mode === "url" ? "url" : "form",
      message: parsed.elicitation.message,
      url: parsed.elicitation.url,
      requestedSchema: isRecord(parsed.elicitation.requestedSchema)
        ? parsed.elicitation.requestedSchema
        : undefined,
      elicitationId:
        typeof parsed.elicitation.elicitationId === "string"
          ? parsed.elicitation.elicitationId
          : typeof parsed.elicitation.id === "string"
            ? parsed.elicitation.id
            : undefined,
    };
  } catch {
    return null;
  }
};

const formatResumePayload = (executionId: string): string =>
  JSON.stringify({ executionId }, null, 2);

export const buildPausedResultText = (envelope: ExecutionEnvelope): string => {
  const interaction = envelope.pendingInteraction;
  const parsed = interaction ? parseInteractionPayload(interaction) : null;

  if (!interaction) {
    return [
      `Execution ${envelope.execution.id} is waiting for interaction.`,
      "Resume with executor.resume using this resumePayload:",
      formatResumePayload(envelope.execution.id),
    ].join("\n");
  }

  const lines = [
    `Execution ${envelope.execution.id} paused: ${parsed?.message ?? "Interaction required."}`,
  ];

  if (parsed?.mode === "url" && typeof parsed.url === "string" && parsed.url.trim().length > 0) {
    lines.push("Open this URL in a browser:");
    lines.push(parsed.url.trim());
    lines.push(
      "After finishing the browser flow, call executor.resume with this resumePayload if your client does not refresh automatically:",
    );
    lines.push(formatResumePayload(envelope.execution.id));
    return lines.join("\n");
  }

  if (parsed?.mode === "form") {
    lines.push(
      "Resume with executor.resume using this resumePayload and include a response object matching the requested schema:",
    );
    lines.push(formatResumePayload(envelope.execution.id));
    return lines.join("\n");
  }

  lines.push("Resume with executor.resume using this resumePayload:");
  lines.push(formatResumePayload(envelope.execution.id));
  return lines.join("\n");
};
