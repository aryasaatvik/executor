import { describe, expect, it } from "@effect/vitest";

import { type ToolDocumentInput, makeFacetChunker, makeWholeChunker } from "./chunker";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal, schema-less tool — should produce exactly one identity chunk. */
const schemalessDoc: ToolDocumentInput = {
  path: "stripe.customers.list",
  name: "customers.list",
  integration: "stripe",
  description: "List all customers.",
};

/** A realistic Stripe subscriptions tool with a 5-paragraph description and
 *  representative TypeScript input/output schemas. */
const stripeSubscriptionsDoc: ToolDocumentInput = {
  path: "stripe.subscriptions.create",
  name: "subscriptions.create",
  integration: "stripe",
  description: `Create a new subscription for a customer to one or more products.

A subscription is the core billing object in Stripe. It schedules recurring charges by anchoring to a billing cycle (monthly, yearly, or a custom interval) and a collection of price items. The customer is billed automatically at the start of each period unless the subscription is in trial or paused.

When creating a subscription, you must specify at least one item referencing a recurring Price object. If the customer has a default payment method on file, Stripe will attempt the first charge immediately; otherwise you can pass payment_behavior: 'default_incomplete' to create the subscription in an incomplete state and collect payment separately.

Subscriptions support a rich set of lifecycle features: free trial periods via trial_period_days or trial_end, proration when upgrading or downgrading mid-cycle, metered billing via usage records, and multiple tax rates. You can also attach metadata, set a custom billing anchor, or pass coupon and promotion codes at creation time.

After creation the subscription moves through statuses: incomplete, trialing, active, past_due, unpaid, and canceled. Webhooks such as customer.subscription.created and invoice.payment_succeeded are the recommended integration path for reacting to these transitions reliably.`,
  inputSchemaText: `{
  customer: string;
  items: Array<{
    price: string;
    quantity?: number;
  }>;
  payment_behavior?: "default_incomplete" | "error_if_incomplete" | "allow_incomplete";
  trial_period_days?: number;
  trial_end?: number | "now";
  coupon?: string;
  promotion_code?: string;
  metadata?: Record<string, string>;
}`,
  outputSchemaText: `{
  id: string;
  object: "subscription";
  customer: string;
  status: "incomplete" | "trialing" | "active" | "past_due" | "unpaid" | "canceled";
  current_period_start: number;
  current_period_end: number;
  items: {
    data: Array<{
      id: string;
      price: { id: string; currency: string; unit_amount: number | null };
      quantity: number;
    }>;
  };
  latest_invoice: string | null;
  trial_start: number | null;
  trial_end: number | null;
}`,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("makeFacetChunker", () => {
  it("schema-less short tool → exactly one identity chunk", () => {
    const chunker = makeFacetChunker();
    const chunks = chunker.chunk("ns", schemalessDoc);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.facet).toBe("identity");
    expect(chunks[0]!.chunkIndex).toBe(0);
    expect(chunks[0]!.path).toBe("stripe.customers.list");
    expect(chunks[0]!.integration).toBe("stripe");
    expect(chunks[0]!.name).toBe("customers.list");
    expect(chunks[0]!.embeddingText).toContain("stripe");
    expect(chunks[0]!.embeddingText).toContain("customers.list");
  });

  it("5-paragraph description → identity + multiple description chunks on paragraph boundaries", () => {
    const budget = 400; // small budget so paragraphs definitely fan out
    const chunker = makeFacetChunker({ facetCharBudget: budget });
    const chunks = chunker.chunk("ns", stripeSubscriptionsDoc);

    // Must have the identity chunk.
    const identityChunks = chunks.filter((c) => c.facet === "identity");
    expect(identityChunks).toHaveLength(1);

    // Must have description continuation chunks (5-paragraph description with
    // remainder beyond the lead).
    const descChunks = chunks.filter((c) => c.facet === "description");
    expect(descChunks.length).toBeGreaterThan(0);

    // No chunk embedding text exceeds the budget.
    chunks
      .filter((c) => c.facet === "identity" || c.facet === "description")
      .forEach((c) => expect(c.embeddingText.length).toBeLessThanOrEqual(budget));

    // Splits land on paragraph boundaries: no description chunk should contain
    // the exact paragraph separator (\n\n) as an internal segment that spans
    // two different source paragraphs in the same budget group. We verify this
    // by checking that each description chunk is a substring of the original
    // description (possibly trimmed) — i.e., no chunk was built by stitching
    // mid-word across a boundary.
    const fullDesc = stripeSubscriptionsDoc.description.trim();
    for (const chunk of descChunks) {
      const text = chunk.embeddingText.trim();
      expect(fullDesc).toContain(text.split("\n\n")[0]!.trim());
    }
  });

  it("tool with inputSchemaText and outputSchemaText → has input and output facets", () => {
    const chunker = makeFacetChunker();
    const chunks = chunker.chunk("ns", stripeSubscriptionsDoc);

    const inputChunks = chunks.filter((c) => c.facet === "input");
    const outputChunks = chunks.filter((c) => c.facet === "output");

    expect(inputChunks).toHaveLength(1);
    expect(outputChunks).toHaveLength(1);

    // The input chunk's embeddingText contains the schema header and schema body.
    expect(inputChunks[0]!.embeddingText).toContain("stripe.subscriptions.create input");
    expect(inputChunks[0]!.embeddingText).toContain("customer: string");

    // The output chunk's embeddingText contains the output schema.
    expect(outputChunks[0]!.embeddingText).toContain("stripe.subscriptions.create output");
    expect(outputChunks[0]!.embeddingText).toContain("status:");
  });

  it("trivial outputSchemaText → no output facet", () => {
    const chunker = makeFacetChunker();
    const doc: ToolDocumentInput = {
      ...stripeSubscriptionsDoc,
      outputSchemaText: "{}",
    };
    const chunks = chunker.chunk("ns", doc);
    expect(chunks.filter((c) => c.facet === "output")).toHaveLength(0);
  });

  it("all ids are ≤ 64 bytes", () => {
    const chunker = makeFacetChunker({ facetCharBudget: 400 });
    const chunks = chunker.chunk(
      "very-long-namespace-that-might-cause-id-bloat",
      stripeSubscriptionsDoc,
    );
    for (const chunk of chunks) {
      expect(chunk.id.length).toBeLessThanOrEqual(64);
    }
  });

  it("chunkIndex increments monotonically across facets", () => {
    const chunker = makeFacetChunker({ facetCharBudget: 400 });
    const chunks = chunker.chunk("ns", stripeSubscriptionsDoc);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.chunkIndex).toBe(i);
    }
  });

  it("ids are stable and deterministic across calls", () => {
    const chunker = makeFacetChunker();
    const a = chunker.chunk("ns", schemalessDoc);
    const b = chunker.chunk("ns", schemalessDoc);
    expect(a[0]!.id).toBe(b[0]!.id);
  });

  it("ids differ across namespaces for the same tool", () => {
    const chunker = makeFacetChunker();
    const a = chunker.chunk("ns1", schemalessDoc);
    const b = chunker.chunk("ns2", schemalessDoc);
    expect(a[0]!.id).not.toBe(b[0]!.id);
  });
});

describe("makeWholeChunker", () => {
  it("always produces exactly one identity chunk", () => {
    const chunker = makeWholeChunker();

    const single = chunker.chunk("ns", schemalessDoc);
    expect(single).toHaveLength(1);
    expect(single[0]!.facet).toBe("identity");

    // Even a rich schema tool produces one chunk.
    const rich = chunker.chunk("ns", stripeSubscriptionsDoc);
    expect(rich).toHaveLength(1);
    expect(rich[0]!.facet).toBe("identity");
  });

  it("embeddingText contains the full description", () => {
    const chunker = makeWholeChunker();
    const chunks = chunker.chunk("ns", stripeSubscriptionsDoc);
    // Spot-check a phrase from the 4th paragraph.
    expect(chunks[0]!.embeddingText).toContain("trial_period_days");
  });

  it("id ≤ 64 bytes", () => {
    const chunker = makeWholeChunker();
    const chunks = chunker.chunk("long-namespace-string-for-safety", stripeSubscriptionsDoc);
    expect(chunks[0]!.id.length).toBeLessThanOrEqual(64);
  });
});
