// ---------------------------------------------------------------------------
// Eval golden set — expected top tool path per query.
//
// Used by eval.ts to compute precision@1 and precision@5 against the embedded
// + ranked results. Keep it small and representative: a few clear-intent
// queries and a few that require deeper semantic matching (e.g. sub-features
// hidden in long descriptions or input schemas).
// ---------------------------------------------------------------------------

export interface GoldenQuery {
  /** The natural-language query used for retrieval. */
  readonly query: string;
  /** The canonical tool path that should rank in the top result. */
  readonly expectedPath: string;
  /** The top-5 set that ALL contain relevant results (for precision@5). */
  readonly expectedTop5: readonly string[];
}

export const GOLDEN: readonly GoldenQuery[] = [
  // --- Google Calendar ---
  {
    query: "create a calendar event",
    expectedPath: "tools.google.org.x.calendar.events.insert",
    expectedTop5: [
      "tools.google.org.x.calendar.events.insert",
      "tools.google.org.x.calendar.events.quickAdd",
    ],
  },
  {
    query: "delete a calendar event",
    expectedPath: "tools.google.org.x.calendar.events.delete",
    expectedTop5: ["tools.google.org.x.calendar.events.delete"],
  },

  // --- Gmail ---
  {
    query: "send an email to recipients",
    expectedPath: "tools.google.org.x.gmail.users.messages.send",
    expectedTop5: ["tools.google.org.x.gmail.users.messages.send"],
  },

  // --- GitHub ---
  {
    query: "open a bug report on a repository",
    expectedPath: "tools.github.org.x.repos.issues.create",
    expectedTop5: [
      "tools.github.org.x.repos.issues.create",
      "tools.github.org.x.repos.pulls.create",
    ],
  },
  {
    query: "make a pull request",
    expectedPath: "tools.github.org.x.repos.pulls.create",
    expectedTop5: [
      "tools.github.org.x.repos.pulls.create",
      "tools.github.org.x.repos.issues.create",
    ],
  },

  // --- Stripe charges + refunds ---
  {
    query: "charge a credit card",
    expectedPath: "tools.stripe.org.x.charges.create",
    expectedTop5: ["tools.stripe.org.x.charges.create", "tools.stripe.org.x.customers.create"],
  },
  {
    query: "give a refund for a payment",
    expectedPath: "tools.stripe.org.x.refunds.create",
    expectedTop5: ["tools.stripe.org.x.refunds.create"],
  },

  // --- Stripe subscriptions — queries that rely on rich description + input facets ---
  {
    query: "start a free trial on a subscription",
    expectedPath: "tools.stripe.org.x.subscriptions.create",
    expectedTop5: ["tools.stripe.org.x.subscriptions.create"],
  },
  {
    query: "cancel a subscription at end of billing period",
    expectedPath: "tools.stripe.org.x.subscriptions.create",
    expectedTop5: ["tools.stripe.org.x.subscriptions.create"],
  },
  {
    query: "prorate a plan change mid-cycle",
    expectedPath: "tools.stripe.org.x.subscriptions.create",
    expectedTop5: ["tools.stripe.org.x.subscriptions.create"],
  },

  // --- Slack ---
  {
    query: "send a message to a Slack channel",
    expectedPath: "tools.slack.org.x.chat.postMessage",
    expectedTop5: ["tools.slack.org.x.chat.postMessage"],
  },

  // --- Linear ---
  {
    query: "create a new Linear issue",
    expectedPath: "tools.linear.org.x.issues.create",
    expectedTop5: ["tools.linear.org.x.issues.create", "tools.github.org.x.repos.issues.create"],
  },
];
