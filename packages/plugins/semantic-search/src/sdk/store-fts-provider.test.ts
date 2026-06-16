import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { type FtsLexicalStore, type FtsSearchResult, makeFtsLexicalProvider } from "./store-fts";

const row = (path: string, integration: string): FtsSearchResult => ({
  path,
  name: path,
  description: "",
  integration,
  score: 1,
});

/** A store that returns the same cross-integration rows regardless of query. */
const mockStore = (rows: readonly FtsSearchResult[]): FtsLexicalStore => ({
  upsert: () => Effect.void,
  deleteByIds: () => Effect.void,
  search: () => Effect.succeed(rows),
});

describe("makeFtsLexicalProvider — namespace filtering", () => {
  const rows = [
    row("github.repos.get", "github"),
    row("github.issues.create", "github"),
    row("stripe.charges.create", "stripe"),
    row("slack.chat.postMessage", "slack"),
  ];

  it.effect("returns all results when no namespace is given", () =>
    Effect.gen(function* () {
      const provider = makeFtsLexicalProvider(mockStore(rows), "default");
      const page = yield* provider.searchTools({
        query: "anything",
        limit: 10,
        offset: 0,
        executor: undefined as never,
      });
      expect(page.items.map((i) => i.path)).toEqual([
        "github.repos.get",
        "github.issues.create",
        "stripe.charges.create",
        "slack.chat.postMessage",
      ]);
      expect(page.total).toBe(4);
    }),
  );

  it.effect(
    "narrows to the integration prefix when namespace is set (matches the vector path)",
    () =>
      Effect.gen(function* () {
        const provider = makeFtsLexicalProvider(mockStore(rows), "default");
        const page = yield* provider.searchTools({
          query: "anything",
          namespace: "github",
          limit: 10,
          offset: 0,
          executor: undefined as never,
        });
        expect(page.items.map((i) => i.path)).toEqual(["github.repos.get", "github.issues.create"]);
        expect(page.total).toBe(2);
        expect(page.hasMore).toBe(false);
      }),
  );
});
