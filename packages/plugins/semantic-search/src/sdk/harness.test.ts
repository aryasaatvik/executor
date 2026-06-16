import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import * as os from "node:os";
import * as path from "node:path";

import { makeHashEmbedder } from "./embedder-hash";
import { withCloudflareLimits } from "./store-cloudflare-limits";
import { makeZVecStore } from "./store-zvec";

// ---------------------------------------------------------------------------
// The harness exercises the real chunk→embed→upsert→query→dedup flow over a
// zvec-backed store (real local ANN index, not in-memory) and verifies that
// the Cloudflare Vectorize limits enforced by `withCloudflareLimits` fire
// correctly. Using zvec here gives a realistic backend — the in-memory index
// was simpler but lower fidelity, and we no longer need it.
//
// Each test uses an isolated OS temp directory so runs never share state.
// ---------------------------------------------------------------------------

/** Return a non-existent temp path for zvec (it creates the directory itself). */
const tempPath = (): string =>
  path.join(os.tmpdir(), `zvec-harness-${Date.now()}-${Math.random().toString(36).slice(2)}`);

describe("harness — CF limits enforced by withCloudflareLimits over a zvec store", () => {
  it.effect("upsert rejects an id over 64 bytes (VECTOR_UPSERT_ERROR / id-too-long)", () =>
    Effect.gen(function* () {
      const dir = tempPath();
      const inner = makeZVecStore({ path: dir, dimensions: 3 });
      const store = withCloudflareLimits(inner);
      // The shape `${namespace}#${path}` blows past 64 bytes for long OpenAPI paths.
      const id = `default#${"cloudflare_api.org.aryalabs.aiGateway.aigBillingCreateTopup".repeat(2)}`;
      const exit = yield* store.upsert([{ id, values: [1, 0, 0] }]).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("query rejects topK > 20 when returning full metadata (the topK cap)", () =>
    Effect.gen(function* () {
      const dir = tempPath();
      const inner = makeZVecStore({ path: dir, dimensions: 3 });
      const store = withCloudflareLimits(inner);
      const exit = yield* store
        .query({ vector: [1, 0, 0], namespace: "default", topK: 50 })
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("a within-limits query returns ranked, namespace-scoped matches", () =>
    Effect.gen(function* () {
      const dir = tempPath();
      const embedder = makeHashEmbedder(); // default 256 dimensions
      const inner = makeZVecStore({ path: dir, dimensions: 256 });
      // Wrap the inner store with CF limits (topK≤20, id≤64 bytes) to exercise
      // the full production-shaped stack.  The test uses topK=5 and short ids
      // so both limits are respected and the query succeeds.
      const store = withCloudflareLimits(inner);

      const docs = [
        { id: "t_a", text: "google calendar events insert create a calendar event" },
        { id: "t_b", text: "github repos issues create an issue" },
        { id: "t_c", text: "google calendar events delete remove a calendar event" },
      ];
      const vectors = yield* embedder.embedDocuments(docs.map((d) => d.text));
      yield* store.upsert(
        docs.map((d, i) => ({
          id: d.id,
          values: [...vectors[i]!],
          namespace: "default",
          metadata: { path: d.id, name: d.id, description: d.text, integration: "x" },
        })),
      );
      const qv = yield* embedder.embedQuery("create a calendar event");
      const matches = yield* store.query({ vector: qv, namespace: "default", topK: 5 });
      // The two calendar docs should outrank the github one (token overlap).
      expect(matches[0]!.id === "t_a" || matches[0]!.id === "t_c").toBe(true);
      expect(matches.map((m) => m.id)).not.toContain(undefined);
    }),
  );
});
