import { Cause, Effect, Exit, Layer } from "effect";

import { ChunkerService, facetChunkerLayer, wholeChunkerLayer } from "./chunker-service";
import type { ToolDocumentInput } from "./chunker";
import {
  EmbedderService,
  geminiEmbedderLayer,
  hashEmbedderLayer,
  openAiCompatibleEmbedderLayer,
} from "./embedding-service";
import { VectorStoreService, zvecStoreLayer } from "./store-service";
import { GOLDEN } from "./eval-golden";

// ---------------------------------------------------------------------------
// Relevance eval — exercises the facet chunker + embed + zvec pipeline locally
// to measure search quality before touching production. The embedder (EMBEDDER)
// and chunker (CHUNKER) are selectable from env; the local vector store is
// always zvec (ZVEC_PATH sets its location):
//
//   # fully offline (no key, no network, default):
//   EMBEDDER=hash ZVEC_PATH="$(mktemp -d)/eval.zvec" CHUNKER=facet \
//     bun run packages/plugins/vectorize-search/src/sdk/eval.ts
//
//   # local OpenAI-compatible endpoint:
//   EMBEDDER=openai OPENAI_BASE_URL=http://localhost:1234/v1 OPENAI_MODEL=… \
//     EMBEDDING_DIMENSIONS=1536 CHUNKER=facet bun run …/eval.ts
//
//   # Gemini (production parity):
//   EMBEDDER=gemini GEMINI_API_KEY=… CHUNKER=facet bun run …/eval.ts
//
// Precision@1 and precision@5 are printed against GOLDEN (eval-golden.ts).
// ---------------------------------------------------------------------------

const NAMESPACE = "default";
const DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS ?? 1536);
const CHUNKER_KIND = process.env.CHUNKER ?? "facet";

// ---------------------------------------------------------------------------
// Sample catalog — realistic tool documents with input/output TypeScript so
// the facet chunker's input + output facets actually fire.
// ---------------------------------------------------------------------------

const SUBSCRIPTION_DESC = [
  "Creates a new subscription on an existing customer. Each customer can have up to 500 active or scheduled subscriptions. A subscription ties a customer to a recurring price and bills them on a schedule (the billing cycle anchor).",
  "When you create a subscription, Stripe attempts to bill the customer immediately for the first invoice, unless you configure otherwise. You can pass items, each referencing a price and an optional quantity, to build a multi-line subscription.",
  "Trial periods: pass trial_period_days or trial_end to start the subscription in a trialing state. During a trial the customer is not charged, and at the end of the trial Stripe generates the first real invoice.",
  "Proration: when a subscription's items or quantities change mid-cycle, Stripe by default prorates the difference, generating proration line items that credit unused time on the old price and charge for the new one. Set proration_behavior to 'none' to disable this.",
  "Cancellation: set cancel_at_period_end to true to schedule the subscription to stop at the end of the current billing period rather than immediately; the customer keeps access until then and is not billed again.",
].join("\n\n");

const SAMPLE: readonly ToolDocumentInput[] = [
  {
    path: "tools.google.org.x.calendar.events.insert",
    name: "events.insert",
    integration: "google",
    description:
      "Creates an event on the specified calendar. The event can include a title, description, start/end time, attendees, location, and recurrence rules.",
    inputTypeScript: `{
  calendarId: string;        // 'primary' or a calendar id
  summary: string;           // event title
  description?: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  attendees?: Array<{ email: string }>;
  location?: string;
  recurrence?: string[];     // RRULE strings
}`,
    outputTypeScript: `{
  id: string;
  htmlLink: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  summary: string;
  start: { dateTime: string };
  end: { dateTime: string };
}`,
  },
  {
    path: "tools.google.org.x.calendar.events.quickAdd",
    name: "events.quickAdd",
    integration: "google",
    description:
      "Creates an event based on a simple text string such as 'Appointment at Somewhere on June 3rd 10am-10:25am'. Google parses the natural-language text to populate the event fields.",
    inputTypeScript: `{
  calendarId: string;
  text: string;   // natural-language event description
  sendUpdates?: 'all' | 'externalOnly' | 'none';
}`,
    outputTypeScript: `{
  id: string;
  htmlLink: string;
  summary: string;
  start: { dateTime: string };
  end: { dateTime: string };
}`,
  },
  {
    path: "tools.google.org.x.calendar.events.delete",
    name: "events.delete",
    integration: "google",
    description:
      "Deletes an event from a calendar. Once deleted the event is removed from the calendar view. For recurring events you can target a single instance or the entire series.",
    inputTypeScript: `{
  calendarId: string;
  eventId: string;
  sendUpdates?: 'all' | 'externalOnly' | 'none';
}`,
    outputTypeScript: "void",
  },
  {
    path: "tools.google.org.x.gmail.users.messages.send",
    name: "messages.send",
    integration: "google",
    description:
      "Sends the specified message to the recipients in the To, Cc, and Bcc headers. The message body is supplied as a base64url-encoded RFC 2822 email string.",
    inputTypeScript: `{
  userId: string;           // 'me' for the authenticated user
  raw: string;              // base64url-encoded RFC 2822 message
  threadId?: string;        // supply to reply in an existing thread
}`,
    outputTypeScript: `{
  id: string;
  threadId: string;
  labelIds: string[];
}`,
  },
  {
    path: "tools.github.org.x.repos.issues.create",
    name: "issues.create",
    integration: "github",
    description:
      "Create an issue in a repository. Any user with pull access to a repository can create an issue. Issues can include a title, body, labels, assignees, and milestone.",
    inputTypeScript: `{
  owner: string;
  repo: string;
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  milestone?: number;
}`,
    outputTypeScript: `{
  id: number;
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  title: string;
}`,
  },
  {
    path: "tools.github.org.x.repos.pulls.create",
    name: "pulls.create",
    integration: "github",
    description:
      "Create a pull request to propose and collaborate on changes to a repository. The pull request includes a title, body, head branch, and base branch to merge into.",
    inputTypeScript: `{
  owner: string;
  repo: string;
  title: string;
  head: string;    // branch with the changes
  base: string;    // branch to merge into
  body?: string;
  draft?: boolean;
}`,
    outputTypeScript: `{
  id: number;
  number: number;
  html_url: string;
  state: 'open' | 'closed' | 'merged';
  title: string;
  mergeable: boolean | null;
}`,
  },
  {
    path: "tools.github.org.x.repos.get",
    name: "repos.get",
    integration: "github",
    description:
      "Gets a repository's metadata, including its description, default branch, visibility, star count, and clone URL.",
    inputTypeScript: `{ owner: string; repo: string }`,
    outputTypeScript: `{
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  default_branch: string;
  stargazers_count: number;
}`,
  },
  {
    path: "tools.stripe.org.x.charges.create",
    name: "charges.create",
    integration: "stripe",
    description:
      "To charge a credit or debit card, you create a Charge object. Stripe attempts to immediately collect funds from the customer's payment source. Pass amount in the smallest currency unit (e.g. cents for USD).",
    inputTypeScript: `{
  amount: number;          // in smallest currency unit (e.g. cents)
  currency: string;        // ISO 4217 code, e.g. 'usd'
  source?: string;         // card token or payment method id
  customer?: string;       // existing customer id
  description?: string;
  metadata?: Record<string, string>;
  capture?: boolean;       // default true; false for auth-only
}`,
    outputTypeScript: `{
  id: string;
  amount: number;
  currency: string;
  status: 'succeeded' | 'pending' | 'failed';
  paid: boolean;
  balance_transaction: string;
}`,
  },
  {
    path: "tools.stripe.org.x.refunds.create",
    name: "refunds.create",
    integration: "stripe",
    description:
      "Refund a charge that has previously been created but not yet refunded. Funds will be refunded to the credit or debit card that was originally charged. You can refund the full amount or a partial amount.",
    inputTypeScript: `{
  charge?: string;           // charge id to refund
  payment_intent?: string;   // or payment_intent id
  amount?: number;           // omit to refund the full charge
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
  metadata?: Record<string, string>;
}`,
    outputTypeScript: `{
  id: string;
  amount: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed' | 'canceled';
  charge: string;
}`,
  },
  {
    path: "tools.stripe.org.x.customers.create",
    name: "customers.create",
    integration: "stripe",
    description:
      "Creates a new customer object you can later charge or attach payment methods to. Customer objects allow you to perform recurring charges, track multiple payments, and store payment details.",
    inputTypeScript: `{
  email?: string;
  name?: string;
  phone?: string;
  description?: string;
  payment_method?: string;
  metadata?: Record<string, string>;
}`,
    outputTypeScript: `{
  id: string;
  email: string | null;
  name: string | null;
  created: number;
  default_source: string | null;
}`,
  },
  {
    path: "tools.slack.org.x.chat.postMessage",
    name: "chat.postMessage",
    integration: "slack",
    description:
      "Sends a message to a channel. The channel can be a public channel, private channel, or direct message. Supports rich formatting via Block Kit or simple markdown text.",
    inputTypeScript: `{
  channel: string;     // channel ID or name
  text?: string;       // plain text fallback
  blocks?: unknown[];  // Block Kit blocks
  thread_ts?: string;  // reply in a thread
  mrkdwn?: boolean;
}`,
    outputTypeScript: `{
  ok: boolean;
  channel: string;
  ts: string;          // message timestamp (also the message id)
  message: { text: string; ts: string };
}`,
  },
  {
    path: "tools.linear.org.x.issues.create",
    name: "issues.create",
    integration: "linear",
    description:
      "Create a new issue in a Linear team, with title, description, assignee, and priority. Issues track work items and bugs within a team's backlog.",
    inputTypeScript: `{
  teamId: string;
  title: string;
  description?: string;     // markdown
  priority?: 0 | 1 | 2 | 3 | 4;  // 0=no priority, 1=urgent, 4=low
  assigneeId?: string;
  labelIds?: string[];
  stateId?: string;
}`,
    outputTypeScript: `{
  id: string;
  identifier: string;  // e.g. 'ENG-123'
  title: string;
  url: string;
  priority: number;
  state: { name: string };
}`,
  },
  {
    path: "tools.stripe.org.x.subscriptions.create",
    name: "subscriptions.create",
    integration: "stripe",
    description: SUBSCRIPTION_DESC,
    inputTypeScript: `{
  customer: string;
  items: Array<{ price: string; quantity?: number }>;
  trial_period_days?: number;
  trial_end?: number | 'now';
  proration_behavior?: 'create_prorations' | 'none' | 'always_invoice';
  cancel_at_period_end?: boolean;
  cancel_at?: number;
  default_payment_method?: string;
  billing_cycle_anchor?: number | 'now';
  metadata?: Record<string, string>;
}`,
    outputTypeScript: `{
  id: string;
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'unpaid' | 'incomplete';
  current_period_start: number;
  current_period_end: number;
  trial_start: number | null;
  trial_end: number | null;
  cancel_at_period_end: boolean;
  items: { data: Array<{ price: { id: string }; quantity: number }> };
}`,
  },
];

// ---------------------------------------------------------------------------
// Precision metrics
// ---------------------------------------------------------------------------

const computePrecision = (
  rankedPaths: readonly string[],
  golden: readonly string[],
  atK: number,
): number => {
  const top = rankedPaths.slice(0, atK);
  const hits = top.filter((p) => golden.includes(p)).length;
  return hits / Math.min(atK, golden.length === 0 ? 1 : golden.length);
};

// ---------------------------------------------------------------------------
// Main program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const embedder = yield* EmbedderService;
  const store = yield* VectorStoreService;
  const chunker = yield* ChunkerService;

  // -------------------------------------------------------------------------
  // Phase 1 — Chunk + embed + upsert
  // -------------------------------------------------------------------------
  const allChunks = SAMPLE.flatMap((doc) => chunker.chunk(NAMESPACE, doc));

  yield* Effect.sync(() => {
    console.log(`\n=== chunking (chunker=${CHUNKER_KIND}) ===`);
    console.log(`tools=${SAMPLE.length}  chunks=${allChunks.length}`);
    // Report per-tool chunk breakdown.
    for (const doc of SAMPLE) {
      const cs = chunker.chunk(NAMESPACE, doc);
      if (cs.length > 1) {
        const facetSummary = cs.map((c) => c.facet).join(", ");
        console.log(`  multi-chunk: ${doc.path} -> ${cs.length} chunks [${facetSummary}]`);
      }
    }
  });

  const vectors = yield* embedder.embedDocuments(allChunks.map((c) => c.embeddingText));

  yield* store.upsert(
    allChunks.map((c, i) => ({
      id: c.id,
      values: [...vectors[i]!],
      namespace: NAMESPACE,
      metadata: {
        path: c.path,
        name: c.name,
        integration: c.integration,
        facet: c.facet,
        chunkIndex: c.chunkIndex,
      },
    })),
  );

  // -------------------------------------------------------------------------
  // Phase 2 — Query, dedup by path (best score), top 5
  // -------------------------------------------------------------------------
  const allQueries = GOLDEN.map((g) => g.query);

  yield* Effect.sync(() =>
    console.log(`\n=== queries (embedder=${embedder.model}, dedup by path, top 5) ===`),
  );

  // Collect ranked results for precision computation.
  const rankedByQuery = new Map<string, readonly string[]>();

  for (const q of allQueries) {
    const qv = yield* embedder.embedQuery(q);
    // Over-fetch so dedup-by-path still yields a full top-5 window.
    const matches = yield* store.query({ vector: qv, namespace: NAMESPACE, topK: 50 });

    const best = new Map<string, { score: number; facet: string; chunkIndex: number }>();
    for (const m of matches) {
      const p = String(m.metadata?.path ?? "");
      if (p === "") continue;
      const prev = best.get(p);
      if (!prev || m.score > prev.score) {
        best.set(p, {
          score: m.score,
          facet: String(m.metadata?.facet ?? ""),
          chunkIndex: Number(m.metadata?.chunkIndex ?? 0),
        });
      }
    }

    const ranked = [...best.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 5);

    rankedByQuery.set(
      q,
      ranked.map(([p]) => p),
    );

    yield* Effect.sync(() => {
      console.log(`\nQ: "${q}"`);
      for (const [p, { score, facet, chunkIndex }] of ranked) {
        console.log(`   ${score.toFixed(3)}  ${p}  (facet=${facet} chunk=${chunkIndex})`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Phase 3 — Precision@1 and precision@5 against the golden set
  // -------------------------------------------------------------------------
  let sumP1 = 0;
  let sumP5 = 0;

  yield* Effect.sync(() => {
    console.log(`\n=== precision summary (chunker=${CHUNKER_KIND}) ===`);
  });

  for (const golden of GOLDEN) {
    const ranked = rankedByQuery.get(golden.query) ?? [];
    const p1 = ranked[0] === golden.expectedPath ? 1 : 0;
    const p5 = computePrecision(ranked, golden.expectedTop5, 5);
    sumP1 += p1;
    sumP5 += p5;

    yield* Effect.sync(() => {
      const hit1 = p1 === 1 ? "✓" : "✗";
      console.log(`  ${hit1} [P@1=${p1}  P@5=${p5.toFixed(2)}]  "${golden.query}"`);
      if (p1 === 0) {
        console.log(`      expected: ${golden.expectedPath}`);
        console.log(`      got:      ${ranked[0] ?? "(none)"}`);
      }
    });
  }

  const n = GOLDEN.length;
  const avgP1 = sumP1 / n;
  const avgP5 = sumP5 / n;

  yield* Effect.sync(() => {
    console.log(
      `\nprecision@1=${avgP1.toFixed(3)}  precision@5=${avgP5.toFixed(3)}  (${n} queries, chunker=${CHUNKER_KIND}, embedder=${embedder.model})`,
    );
    if (embedder.model.startsWith("hash")) {
      console.log(
        "(note: hash embedder is deterministic but weak — low precision is expected offline)",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Layer selection from env
// ---------------------------------------------------------------------------

const embedderLayer = (): Layer.Layer<EmbedderService> => {
  const kind = process.env.EMBEDDER ?? "gemini";
  if (kind === "openai") {
    return openAiCompatibleEmbedderLayer({
      baseUrl: process.env.OPENAI_BASE_URL ?? "http://localhost:1234/v1",
      model: process.env.OPENAI_MODEL ?? "text-embedding-3-small",
      dimensions: DIMENSIONS,
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  if (kind === "hash") return hashEmbedderLayer(DIMENSIONS);
  return geminiEmbedderLayer({
    apiKey: process.env.GEMINI_API_KEY?.trim() ?? "",
    model: process.env.GEMINI_EMBEDDING_MODEL?.trim() || undefined,
    dimensions: DIMENSIONS,
  });
};

const storeLayer = (): Layer.Layer<VectorStoreService> => {
  // Default to zvec (no in-memory store — removed in P0).
  return zvecStoreLayer({
    path: process.env.ZVEC_PATH ?? "/tmp/vectorize-eval.zvec",
    dimensions: DIMENSIONS,
  });
};

const chunkerLayer = (): Layer.Layer<ChunkerService> => {
  if (CHUNKER_KIND === "whole") return wholeChunkerLayer();
  // Default: facet chunker.
  return facetChunkerLayer();
};

const exit = await Effect.runPromiseExit(
  program.pipe(Effect.provide(Layer.mergeAll(embedderLayer(), storeLayer(), chunkerLayer()))),
);
if (Exit.isFailure(exit)) {
  console.error(Cause.pretty(exit.cause));
  process.exit(1);
}
