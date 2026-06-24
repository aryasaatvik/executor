import * as Atom from "effect/unstable/reactivity/Atom";

import { SemanticSearchClient } from "./client";

export interface SearchInput {
  readonly q: string;
  readonly limit: number;
}

// One cached result per (query, limit). An empty `q` is a cheap no-op on the
// server (the provider short-circuits before embedding), so the page can read
// this atom unconditionally and gate on the submitted query in the view.
export const searchAtom = Atom.family((input: SearchInput) =>
  SemanticSearchClient.query("semanticSearch", "search", {
    query: { q: input.q, limit: input.limit },
    timeToLive: "30 seconds",
    reactivityKeys: [],
  }),
);

// Index status from local item rows and remote AI Search item states.
export const statusAtom = SemanticSearchClient.query("semanticSearch", "status", {
  timeToLive: "10 seconds",
  reactivityKeys: [],
});

// Explicit catalog upload into AI Search.
export const reindexMutation = SemanticSearchClient.mutation("semanticSearch", "reindex");
