// ---------------------------------------------------------------------------
// @executor-js/plugin-service-tokens/client
//
// Frontend half: a "Service Tokens" page (sidebar tab) for managing
// `common_name → subject` aliases. After creating a service token in Cloudflare
// Access, paste its `common_name` here and "Alias to me" — the token then acts
// as your identity (resolves your Personal connections) when an MCP client
// presents its `Cf-Access-Client-Id`/`-Secret` headers.
//
// The alias always targets the CALLING user's own subject (the server reads it
// from the request principal), so you can only ever map a token to yourself.
//
// Server-only deps (Effect/Node) MUST NOT be imported here.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { createPluginAtomClient, defineClientPlugin } from "@executor-js/sdk/client";
import {
  getExecutorApiBaseUrl,
  getExecutorServerAuthorizationHeader,
} from "@executor-js/react/api/server-connection";
import { Button } from "@executor-js/react/components/button";
import { Input } from "@executor-js/react/components/input";
import {
  CardStackEntry,
  CardStackEntryActions,
  CardStackEntryContent,
  CardStackEntryDescription,
} from "@executor-js/react/components/card-stack";

import type { ServiceTokenAlias } from "./shared";
import { ServiceTokensApi } from "./shared";

const Client = createPluginAtomClient(ServiceTokensApi, {
  baseUrl: getExecutorApiBaseUrl,
  authorizationHeader: getExecutorServerAuthorizationHeader,
});

const aliasesAtom = Client.query("serviceTokens", "list", {
  timeToLive: "10 seconds",
  reactivityKeys: [],
});
const aliasMutation = Client.mutation("serviceTokens", "alias");
const unaliasMutation = Client.mutation("serviceTokens", "unalias");

function ServiceTokensPage() {
  const [commonName, setCommonName] = useState("");
  const [machineName, setMachineName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const aliasesResult = useAtomValue(aliasesAtom);
  const refresh = useAtomRefresh(aliasesAtom);
  const doAlias = useAtomSet(aliasMutation, { mode: "promiseExit" });
  const doUnalias = useAtomSet(unaliasMutation, { mode: "promiseExit" });

  const typed = aliasesResult as AsyncResult.AsyncResult<readonly ServiceTokenAlias[], unknown>;
  const aliases = AsyncResult.match(typed, {
    onInitial: () => [] as readonly ServiceTokenAlias[],
    onFailure: () => [] as readonly ServiceTokenAlias[],
    onSuccess: ({ value }) => value,
  });
  const isLoading = AsyncResult.match(typed, {
    onInitial: () => true,
    onFailure: () => false,
    onSuccess: () => false,
  });
  const isError = AsyncResult.match(typed, {
    onInitial: () => false,
    onFailure: () => true,
    onSuccess: () => false,
  });

  const handleAlias = async () => {
    const name = commonName.trim();
    if (!name) return;
    const machine = machineName.trim();
    setBusy(true);
    setError(null);
    const exit = await doAlias({
      payload: { commonName: name, ...(machine ? { machineName: machine } : {}) },
      reactivityKeys: [],
    });
    setBusy(false);
    if (Exit.isFailure(exit)) {
      setError("Failed to create alias");
      return;
    }
    setCommonName("");
    setMachineName("");
    refresh();
  };

  const handleUnalias = async (name: string) => {
    const exit = await doUnalias({ payload: { commonName: name }, reactivityKeys: [] });
    if (!Exit.isFailure(exit)) refresh();
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10 lg:px-8 lg:py-14">
        <div className="mb-10">
          <h1 className="font-display text-[2rem] tracking-tight text-foreground leading-none">
            Service Tokens
          </h1>
          <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
            Map a Cloudflare Access service token to your identity. A machine token that presents{" "}
            <span className="font-mono text-[12px]">Cf-Access-Client-Id</span>/
            <span className="font-mono text-[12px]">-Secret</span> headers then acts as you —
            resolving your Personal connections instead of its own empty partition.
          </p>
        </div>

        <div className="mb-8 flex gap-2">
          <Input
            placeholder="service-token common_name (Client ID)"
            value={commonName}
            onChange={(e) => setCommonName((e.target as HTMLInputElement).value)}
            className="h-9 flex-[2] font-mono text-[13px]"
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAlias();
            }}
          />
          <Input
            placeholder="machine name (optional)"
            value={machineName}
            onChange={(e) => setMachineName((e.target as HTMLInputElement).value)}
            className="h-9 flex-1 text-[13px]"
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAlias();
            }}
          />
          <Button size="sm" onClick={handleAlias} disabled={!commonName.trim() || busy}>
            {busy ? "Aliasing…" : "Alias to me"}
          </Button>
        </div>

        {error && (
          <div className="mb-6 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2">
            <p className="text-[12px] text-destructive">{error}</p>
          </div>
        )}

        {isLoading ? (
          <CardStackEntry>
            <CardStackEntryContent>
              <CardStackEntryDescription>Loading…</CardStackEntryDescription>
            </CardStackEntryContent>
          </CardStackEntry>
        ) : isError ? (
          <CardStackEntry>
            <CardStackEntryContent>
              <CardStackEntryDescription className="text-destructive">
                Failed to load aliases
              </CardStackEntryDescription>
            </CardStackEntryContent>
          </CardStackEntry>
        ) : aliases.length === 0 ? (
          <CardStackEntry>
            <CardStackEntryContent>
              <CardStackEntryDescription>
                No service-token aliases yet. Create a token in Cloudflare Access, then paste its
                Client ID above.
              </CardStackEntryDescription>
            </CardStackEntryContent>
          </CardStackEntry>
        ) : (
          aliases.map((alias) => (
            <CardStackEntry key={alias.commonName}>
              <CardStackEntryContent>
                <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-[12px]">
                  {alias.machineName ? (
                    <>
                      <span className="text-muted-foreground/60">Name</span>
                      <span className="truncate text-foreground/90">{alias.machineName}</span>
                    </>
                  ) : null}
                  <span className="text-muted-foreground/60">Token</span>
                  <span className="truncate font-mono text-foreground/80">{alias.commonName}</span>
                  <span className="text-muted-foreground/60">Acts as</span>
                  <span className="truncate font-mono text-foreground/80">
                    {alias.email ?? alias.name ?? alias.subject}
                  </span>
                </div>
              </CardStackEntryContent>
              <CardStackEntryActions>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2.5 text-[12px] text-destructive/70 hover:text-destructive"
                  onClick={() => handleUnalias(alias.commonName)}
                >
                  Remove
                </Button>
              </CardStackEntryActions>
            </CardStackEntry>
          ))
        )}
      </div>
    </div>
  );
}

export default defineClientPlugin({
  id: "service-tokens" as const,
  pages: [
    {
      path: "/",
      component: ServiceTokensPage,
      nav: { label: "Service Tokens" },
    },
  ],
});
