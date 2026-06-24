import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { RunRow } from "./collections";

// ---------------------------------------------------------------------------
// Schema-evolution tolerance for the JSON-document `runs` collection.
//
// `#20` added actorId/actorLabel/actorKind. Runs stored BEFORE that have no such
// key at all. The store passes the raw stored doc straight to the HTTP response
// encoder, so a legacy doc must both decode AND encode through `RunRow` without a
// "Missing key" error — otherwise the entire runs list 400s on the newest page.
// These fields use an optional key + a decoding default of null precisely so
// that holds.
// ---------------------------------------------------------------------------

// Hoisted: `Schema.*Sync` compiles a function, so it must not be rebuilt per call.
const decodeRunRow = Schema.decodeUnknownSync(RunRow);
const encodeRunRow = Schema.encodeUnknownSync(RunRow);

// A run document as written before the actor fields existed: the three actor
// keys are physically absent.
const legacyRunDoc = {
  executionId: "exec_legacy",
  status: "completed",
  codePreview: "noop",
  triggerKind: null,
  logErrorCount: 0,
  logWarnCount: 0,
  startedAt: 1000,
  completedAt: 2000,
  durationMs: 1000,
  toolCallCount: 0,
  hadInteraction: false,
};

describe("RunRow legacy-document tolerance", () => {
  it("decodes a legacy doc, defaulting the absent actor fields to null", () => {
    const decoded = decodeRunRow(legacyRunDoc);
    expect(decoded.actorId).toBeNull();
    expect(decoded.actorLabel).toBeNull();
    expect(decoded.actorKind).toBeNull();
    expect(decoded.hadFormApproval).toBe(false);
    expect(decoded.hadUrlApproval).toBe(false);
    // The decoded type is `string | null` (always present) — readers treat it as
    // required; it just defaults to null for pre-actor runs.
    expect(decoded.executionId).toBe("exec_legacy");
  });

  it("encodes a legacy doc with the actor keys absent (the runs-response regression)", () => {
    // The store hands the raw stored doc to the response encoder, so the encode
    // input is the legacy shape itself. With `NullOr` this threw
    // "Missing key at [actorId]"; with the optional key it must succeed, and the
    // absent actor keys stay absent (the encoder must not fabricate them).
    const encoded = encodeRunRow(legacyRunDoc);
    expect(encoded.executionId).toBe("exec_legacy");
    expect(encoded.actorId ?? null).toBeNull();
    expect(encoded.actorLabel ?? null).toBeNull();
    expect(encoded.actorKind ?? null).toBeNull();
    expect(encoded.hadFormApproval ?? false).toBe(false);
    expect(encoded.hadUrlApproval ?? false).toBe(false);
  });

  it("round-trips a run that DOES carry an actor through decode AND encode", () => {
    const withActor = {
      ...legacyRunDoc,
      actorId: "tok.access",
      actorLabel: "phoenix",
      actorKind: "service-token",
    };
    const decoded = decodeRunRow(withActor);
    expect(decoded.actorId).toBe("tok.access");
    expect(decoded.actorLabel).toBe("phoenix");
    expect(decoded.actorKind).toBe("service-token");
    // Encode must carry the present keys through unchanged (the path the runs
    // response actually takes for an attributed run).
    const encoded = encodeRunRow(decoded);
    expect(encoded.actorId).toBe("tok.access");
    expect(encoded.actorLabel).toBe("phoenix");
    expect(encoded.actorKind).toBe("service-token");
  });
});
