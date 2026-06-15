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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@executor-js/react/components/table";

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
  // Inline edit of an existing alias's machine name. `editing` holds the
  // commonName of the card in edit mode (null = none). Saving reuses the `alias`
  // upsert, so it also re-captures the editor's acts-as identity — fine here
  // because you only ever edit your own aliases.
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editBusy, setEditBusy] = useState(false);

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
      payload: {
        commonName: name,
        ...(machine ? { machineName: machine } : {}),
      },
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
    const exit = await doUnalias({
      payload: { commonName: name },
      reactivityKeys: [],
    });
    if (!Exit.isFailure(exit)) refresh();
  };

  const startEdit = (alias: ServiceTokenAlias) => {
    setEditing(alias.commonName);
    setEditValue(alias.machineName ?? "");
    setError(null);
  };

  const handleSaveEdit = async (commonNameToEdit: string) => {
    const machine = editValue.trim();
    setEditBusy(true);
    setError(null);
    const exit = await doAlias({
      payload: {
        commonName: commonNameToEdit,
        ...(machine ? { machineName: machine } : {}),
      },
      reactivityKeys: [],
    });
    setEditBusy(false);
    if (Exit.isFailure(exit)) {
      setError("Failed to update machine name");
      return;
    }
    setEditing(null);
    refresh();
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-10 lg:px-8 lg:py-14">
        <div className="mb-10 max-w-2xl">
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

        <div className="mb-8 max-w-2xl space-y-2">
          <Input
            placeholder="service-token common_name (Client ID)"
            value={commonName}
            onChange={(e) => setCommonName((e.target as HTMLInputElement).value)}
            className="h-9 w-full font-mono text-[13px]"
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAlias();
            }}
          />
          <div className="flex gap-2">
            <Input
              placeholder="machine name (optional)"
              value={machineName}
              onChange={(e) => setMachineName((e.target as HTMLInputElement).value)}
              className="h-9 min-w-0 flex-1 text-[13px]"
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleAlias();
              }}
            />
            <Button size="sm" onClick={handleAlias} disabled={!commonName.trim() || busy}>
              {busy ? "Aliasing…" : "Alias to me"}
            </Button>
          </div>
        </div>

        {error && (
          <div className="mb-6 max-w-2xl rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2">
            <p className="text-[12px] text-destructive">{error}</p>
          </div>
        )}

        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[180px] text-xs font-normal text-muted-foreground/60">
                Name
              </TableHead>
              <TableHead className="text-xs font-normal text-muted-foreground/60">Token</TableHead>
              <TableHead className="text-xs font-normal text-muted-foreground/60">
                Acts as
              </TableHead>
              <TableHead className="w-[1%]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="py-6 text-center text-xs text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="py-6 text-center text-xs text-destructive">
                  Failed to load aliases
                </TableCell>
              </TableRow>
            ) : aliases.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="py-6 text-center text-xs text-muted-foreground">
                  No service-token aliases yet. Create a token in Cloudflare Access, then paste its
                  Client ID above.
                </TableCell>
              </TableRow>
            ) : (
              aliases.map((alias) => {
                const isEditing = editing === alias.commonName;
                const actsAs = alias.email ?? alias.name ?? alias.subject;
                return (
                  <TableRow key={alias.commonName} className="group">
                    <TableCell>
                      {isEditing ? (
                        <Input
                          autoFocus
                          placeholder="machine name"
                          value={editValue}
                          onChange={(e) => setEditValue((e.target as HTMLInputElement).value)}
                          className="h-7 max-w-[180px] text-xs"
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void handleSaveEdit(alias.commonName);
                            if (e.key === "Escape") setEditing(null);
                          }}
                        />
                      ) : alias.machineName ? (
                        <span className="text-foreground/90">{alias.machineName}</span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-foreground/70">
                      <span className="block max-w-[360px] truncate" title={alias.commonName}>
                        {alias.commonName}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      <span className="block max-w-[300px] truncate" title={actsAs}>
                        {actsAs}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      {isEditing ? (
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            className="h-7 px-2.5 text-[12px]"
                            onClick={() => handleSaveEdit(alias.commonName)}
                            disabled={editBusy}
                          >
                            {editBusy ? "Saving…" : "Save"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2.5 text-[12px]"
                            onClick={() => setEditing(null)}
                            disabled={editBusy}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <div className="flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2.5 text-[12px]"
                            onClick={() => startEdit(alias)}
                          >
                            {alias.machineName ? "Edit" : "Add name"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2.5 text-[12px] text-destructive/70 hover:text-destructive"
                            onClick={() => handleUnalias(alias.commonName)}
                          >
                            Remove
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
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
