import { Effect, Layer } from "effect";
import { HttpEffect, HttpRouter } from "effect/unstable/http";

import { dbProviderLayer, ExecutorApp, textFailureStrategy } from "@executor-js/api/server";
import { layerCloudflareKeyValueStore } from "@executor-js/cloudflare/key-value-store";

import { loadConfig, type CloudflareEnv } from "./config";
import { makeCloudflarePlugins } from "./plugins";
import { createD1ExecutorDb } from "./db/d1";
import { cloudflareAccessIdentityLayer } from "./auth/cloudflare-access";
import { makeServiceTokenAliasLookup } from "./auth/service-token-alias";
import {
  CloudflareCodeExecutorProvider,
  makeCloudflareHostConfig,
  makeCloudflarePluginsProvider,
} from "./execution";
import { ErrorCaptureLive } from "./observability";
import { cloudflareAccountMiddleware } from "./account/account-provider";
import { makeCloudflareApprovalHandler } from "./mcp";
import { makeCloudflareMcpAgentHandler } from "./mcp/agent-handler";
import { preloadQuickJs } from "./quickjs";

// ===========================================================================
// The Cloudflare host, as ONE `ExecutorApp.make` call — the 4th app alongside
// cloud / self-host / local, differing only by the injected Layers.
//
// The whole scenario in 60 seconds: Cloudflare Access is the identity (validate
// the Cf-Access-Jwt-Assertion JWT — no Better Auth, no WorkOS, no app login),
// D1 is the SQLite store (same FumaDB assembly as self-host), QuickJS is the
// in-process code substrate, no billing, single-tenant. `diff` against
// host-selfhost/src/app.ts is three injected Layers: identity, db, plugins/config.
//
// Built per isolate (async) so the D1 schema bring-up happens once at first
// fetch; `env` arrives with that fetch (a Worker has no module-scope bindings),
// so the providers close over it instead of reading process.env.
// ===========================================================================

export const makeCloudflareApp = async (env: CloudflareEnv) => {
  const config = loadConfig(env);
  const plugins = makeCloudflarePlugins(
    config.secretKey,
    env.ANALYTICS,
    env.VECTORIZE,
    config.geminiApiKey,
    config.organizationId,
  );

  // Load the Workers-compatible (WASM-inlined) QuickJS variant before any
  // executor is built — the default variant can't fetch its .wasm on Workers.
  await preloadQuickJs();

  // Open + idempotently bring up the D1 schema once (the long-lived handle the
  // per-request scoped executor reads through the DbProvider seam).
  const dbHandle = await createD1ExecutorDb(env.DB, env.BLOBS);
  // Resolve service-token → human-subject aliases (written by the service-tokens
  // plugin) at JWT-verify time, so a machine token can ACT AS the user it is
  // mapped to. Shared by the API gate, the account `me`, and the `/mcp` gate so
  // all three agree on identity. Reads the long-lived `dbHandle`.
  const aliasLookup = makeServiceTokenAliasLookup(dbHandle, config.organizationId);
  const identityLayer = cloudflareAccessIdentityLayer(config, aliasLookup);
  const bootLayer =
    env.CACHE === undefined
      ? identityLayer
      : Layer.mergeAll(identityLayer, layerCloudflareKeyValueStore(env.CACHE));
  // `/mcp` is mounted in worker.ts through the Agents Streamable HTTP bridge
  // because it needs the Cloudflare ExecutionContext.
  const mcpAgentHandler = makeCloudflareMcpAgentHandler(config, aliasLookup);
  const approvalHandler = makeCloudflareApprovalHandler(config, env);

  const { appLayer, toWebHandler } = ExecutorApp.make({
    plugins,
    providers: {
      identity: identityLayer,
      db: dbProviderLayer(Effect.succeed(dbHandle)),
      engine: { codeExecutor: CloudflareCodeExecutorProvider }, // decorator defaults to no-op
      plugins: {
        provider: makeCloudflarePluginsProvider(config),
        config: makeCloudflareHostConfig(config),
      },
      errorCapture: ErrorCaptureLive,
      // The account API (`/api/account/*`) backs the shared multiplayer shell's
      // auth context; `me` reflects the Access principal. Members/keys are
      // Access-managed, so the rest of the surface is stubbed.
      account: cloudflareAccountMiddleware(config, aliasLookup),
    },
    extensions: {
      routes: [
        // Browser approval of paused MCP executions: the console resume page
        // reads paused detail (GET) and records the decision (POST .../resume),
        // Access-gated, routed to the owning session's Durable Object.
        HttpRouter.add("*", "/api/mcp-sessions/*", HttpEffect.fromWebHandler(approvalHandler)),
      ],
    },
    config: { mountPrefix: "/api", failure: textFailureStrategy },
    boot: bootLayer,
  });

  return { appLayer, toWebHandler, mcpAgentHandler };
};
