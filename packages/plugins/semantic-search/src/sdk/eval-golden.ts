// ---------------------------------------------------------------------------
// Eval golden set — expected top tool path per query.
//
// Used by eval.ts to compute precision@1 and precision@5 against the embedded
// + ranked results. Keep it small and representative: a few clear-intent
// queries and a few that require deeper semantic matching (e.g. sub-features
// hidden in long descriptions or input schemas).
//
// Real-catalog entries (CATALOG=real) use paths of the form
// "<integration>.<name>" matching the path field produced by the catalog
// loader in eval.ts. Sample-catalog entries use the old hand-crafted dotted
// paths. Both share the same GoldenQuery shape.
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
  // ---------------------------------------------------------------------------
  // GitHub (real catalog: integration=github)
  // ---------------------------------------------------------------------------
  {
    query: "create a new GitHub repository for the authenticated user",
    expectedPath: "github.repos.createForAuthenticatedUser",
    expectedTop5: [
      "github.repos.createForAuthenticatedUser",
      "github.repos.createInOrg",
      "github.repos.createUsingTemplate",
    ],
  },
  {
    query: "read the contents of a file in a GitHub repository",
    expectedPath: "github.repos.getContent",
    expectedTop5: ["github.repos.getContent", "github.repos.getReadme"],
  },
  {
    query: "create or update a file in a GitHub repo",
    expectedPath: "github.repos.createOrUpdateFileContents",
    expectedTop5: ["github.repos.createOrUpdateFileContents", "github.repos.getContent"],
  },
  {
    query: "publish a new release on GitHub",
    expectedPath: "github.repos.createRelease",
    expectedTop5: [
      "github.repos.createRelease",
      "github.repos.listReleases",
      "github.repos.getLatestRelease",
    ],
  },
  {
    query: "register a webhook on a GitHub repository",
    expectedPath: "github.repos.createWebhook",
    expectedTop5: ["github.repos.createWebhook"],
  },
  {
    query: "look up a GitHub user's profile by username",
    expectedPath: "github.users.getByUsername",
    expectedTop5: ["github.users.getByUsername", "github.users.getById"],
  },
  {
    query: "trigger a GitHub Actions workflow run manually",
    expectedPath: "github.actions.createWorkflowDispatch",
    expectedTop5: ["github.actions.createWorkflowDispatch"],
  },
  {
    query: "cancel a running GitHub Actions workflow",
    expectedPath: "github.actions.cancelWorkflowRun",
    expectedTop5: ["github.actions.cancelWorkflowRun", "github.actions.forceCancelWorkflowRun"],
  },

  // ---------------------------------------------------------------------------
  // Stripe API (real catalog: integration=stripe_api)
  // ---------------------------------------------------------------------------
  {
    query: "create a new Stripe customer",
    expectedPath: "stripe_api.customers.postCustomers",
    expectedTop5: ["stripe_api.customers.postCustomers"],
  },
  {
    query: "create a payment intent to charge a customer",
    expectedPath: "stripe_api.paymentIntents.postPaymentIntents",
    expectedTop5: [
      "stripe_api.paymentIntents.postPaymentIntents",
      "stripe_api.customers.postCustomers",
    ],
  },
  {
    query: "set up a recurring subscription for a customer",
    expectedPath: "stripe_api.subscriptions.postSubscriptions",
    expectedTop5: ["stripe_api.subscriptions.postSubscriptions"],
  },
  {
    query: "issue a refund for a Stripe payment",
    expectedPath: "stripe_api.refunds.postRefunds",
    expectedTop5: ["stripe_api.refunds.postRefunds"],
  },
  {
    query: "create a draft invoice for a customer",
    expectedPath: "stripe_api.invoices.postInvoices",
    expectedTop5: ["stripe_api.invoices.postInvoices", "stripe_api.customers.postCustomers"],
  },

  // ---------------------------------------------------------------------------
  // Sentry (real catalog: integration=sentry)
  // ---------------------------------------------------------------------------
  {
    query: "bulk resolve or ignore a list of Sentry issues",
    expectedPath: "sentry.events.bulkMutateAListOfIssues",
    expectedTop5: [
      "sentry.events.bulkMutateAListOfIssues",
      "sentry.events.bulkMutateAnOrganizationSIssues",
    ],
  },
  {
    query: "save a Discover query in Sentry",
    expectedPath: "sentry.discover.createANewSavedQuery",
    expectedTop5: ["sentry.discover.createANewSavedQuery"],
  },
  {
    query: "set up a cron job monitor in Sentry",
    expectedPath: "sentry.crons.createAMonitor",
    expectedTop5: ["sentry.crons.createAMonitor", "sentry.crons.updateAMonitor"],
  },

  // ---------------------------------------------------------------------------
  // PostHog (real catalog: integration=posthog)
  // ---------------------------------------------------------------------------
  {
    query: "create a user survey in PostHog",
    expectedPath: "posthog.survey_create",
    expectedTop5: ["posthog.survey_create"],
  },
  {
    query: "run a HogQL analytics query against PostHog data",
    expectedPath: "posthog.query_run",
    expectedTop5: ["posthog.query_run", "posthog.query_validate"],
  },
  {
    query: "get A/B test experiment results in PostHog",
    expectedPath: "posthog.experiment_results_get",
    expectedTop5: ["posthog.experiment_results_get"],
  },

  // ---------------------------------------------------------------------------
  // Gmail (real catalog: integration=gmail)
  // ---------------------------------------------------------------------------
  {
    query: "send an email via Gmail",
    expectedPath: "gmail.users.messages.send",
    expectedTop5: ["gmail.users.messages.send", "gmail.users.drafts.send"],
  },
  {
    query: "list messages in a Gmail mailbox",
    expectedPath: "gmail.users.messages.list",
    expectedTop5: ["gmail.users.messages.list"],
  },
  {
    query: "create a Gmail label",
    expectedPath: "gmail.users.labels.create",
    expectedTop5: ["gmail.users.labels.create"],
  },
  {
    query: "save an email as a draft in Gmail",
    expectedPath: "gmail.users.drafts.create",
    expectedTop5: ["gmail.users.drafts.create", "gmail.users.drafts.update"],
  },

  // ---------------------------------------------------------------------------
  // Spotify (real catalog: integration=spotify_web_api)
  // ---------------------------------------------------------------------------
  {
    query: "start playing music on a Spotify device",
    expectedPath: "spotify_web_api.player.startAUsersPlayback",
    expectedTop5: [
      "spotify_web_api.player.startAUsersPlayback",
      "spotify_web_api.player.resumePlayback",
    ],
  },
  {
    query: "search for tracks or artists on Spotify",
    expectedPath: "spotify_web_api.search.getOperation",
    expectedTop5: ["spotify_web_api.search.getOperation"],
  },
  {
    query: "create a new Spotify playlist",
    expectedPath: "spotify_web_api.playlists.createPlaylist",
    expectedTop5: ["spotify_web_api.playlists.createPlaylist"],
  },

  // ---------------------------------------------------------------------------
  // Neon (real catalog: integration=neon)
  // ---------------------------------------------------------------------------
  {
    query: "create a new Neon database project",
    expectedPath: "neon.create_project",
    expectedTop5: ["neon.create_project"],
  },
  {
    query: "branch a Neon database for a feature or migration",
    expectedPath: "neon.create_branch",
    expectedTop5: ["neon.create_branch", "neon.prepare_database_migration"],
  },
  {
    query: "run a SQL query against a Neon database",
    expectedPath: "neon.run_sql",
    expectedTop5: ["neon.run_sql", "neon.run_sql_transaction"],
  },

  // ---------------------------------------------------------------------------
  // Axiom (real catalog: integration=axiom)
  // ---------------------------------------------------------------------------
  {
    query: "query log events with APL in Axiom",
    expectedPath: "axiom.querydataset",
    expectedTop5: ["axiom.querydataset", "axiom.querymetrics"],
  },

  // ---------------------------------------------------------------------------
  // Exa (real catalog: integration=exa)
  // ---------------------------------------------------------------------------
  {
    query: "search the web for recent information",
    expectedPath: "exa.web_search_exa",
    expectedTop5: ["exa.web_search_exa", "exa.web_fetch_exa"],
  },
];
