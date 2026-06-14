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
// These fields use `optionalWith({ default: null })` precisely so that holds.
// ---------------------------------------------------------------------------

// Hoisted: `Schema.*Sync` compiles a function, so it must not be rebuilt per call.
const decodeRunRow = Schema.decodeUnknownSync(RunRow);
const encodeRunRow = Schema.encodeUnknownSync(RunRow);

// A run document as written before the actor fields existed: the three actor
// keys are physically absent.
const legacyRunDoc = {
  executionId: "exec_legacy",
  status: "completed",
  code: "noop",
  resultJson: null,
  errorText: null,
  logsJson: null,
  triggerKind: null,
  triggerMetaJson: null,
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
    // The decoded type is `string | null` (always present) — readers treat it as
    // required; it just defaults to null for pre-actor runs.
    expect(decoded.executionId).toBe("exec_legacy");
  });

  it("encodes a legacy doc with the actor keys absent (the runs-response regression)", () => {
    // The store hands the raw stored doc to the response encoder, so the encode
    // input is the legacy shape itself. With `NullOr` this threw
    // "Missing key at [actorId]"; with the optional key it must succeed.
    const encoded = encodeRunRow(legacyRunDoc);
    expect(encoded.executionId).toBe("exec_legacy");
  });

  it("round-trips a run that DOES carry an actor", () => {
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
  });
});
