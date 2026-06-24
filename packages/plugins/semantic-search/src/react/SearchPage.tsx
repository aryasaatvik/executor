import { useState } from "react";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { RefreshCw, Search } from "lucide-react";
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

import type { SearchResponseType, StatusResponseType } from "../api/group";
import { reindexMutation, searchAtom, statusAtom } from "./atoms";

const SEARCH_LIMIT = 25;

// Operator/debug page for the semantic-search plugin: a live `tools.search` box
// over the engine's AI Search provider, an item status line, and an explicit
// reindex trigger. Read-only against the catalog, except for reindex.
export function SearchPage() {
  const [input, setInput] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [reindexing, setReindexing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const searchResult = useAtomValue(
    searchAtom({ q: submitted, limit: SEARCH_LIMIT }),
  ) as AsyncResult.AsyncResult<SearchResponseType, unknown>;
  const statusResult = useAtomValue(statusAtom) as AsyncResult.AsyncResult<
    StatusResponseType,
    unknown
  >;
  const refreshStatus = useAtomRefresh(statusAtom);
  const doReindex = useAtomSet(reindexMutation, { mode: "promiseExit" });

  const items = AsyncResult.match(searchResult, {
    onInitial: () => [] as SearchResponseType["items"],
    onFailure: () => [] as SearchResponseType["items"],
    onSuccess: ({ value }) => value.items,
  });
  const searching = AsyncResult.match(searchResult, {
    onInitial: () => submitted.length > 0,
    onFailure: () => false,
    onSuccess: () => false,
  });
  const searchFailed = AsyncResult.match(searchResult, {
    onInitial: () => false,
    onFailure: () => true,
    onSuccess: () => false,
  });
  const status = AsyncResult.match(statusResult, {
    onInitial: () => null,
    onFailure: () => null,
    onSuccess: ({ value }) => value,
  });

  const runSearch = () => setSubmitted(input.trim());

  const handleReindex = async () => {
    setReindexing(true);
    setNotice(null);
    const exit = await doReindex({ reactivityKeys: [] });
    setReindexing(false);
    if (Exit.isFailure(exit)) {
      setNotice("Reindex failed. Check the Worker logs for the AI Search upload error.");
      return;
    }
    setNotice("Reindex queued.");
    refreshStatus();
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-10 lg:px-8 lg:py-14">
        <div className="mb-8 flex items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h1 className="font-display text-[2rem] tracking-tight text-foreground leading-none">
              Search
            </h1>
            <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
              Run a live <span className="font-mono text-[12px]">tools.search</span> through the
              engine's Cloudflare AI Search provider. This is what the agent sees.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handleReindex}
            disabled={reindexing}
            className="shrink-0"
          >
            <RefreshCw className={`mr-2 h-3.5 w-3.5 ${reindexing ? "animate-spin" : ""}`} />
            {reindexing ? "Reindexing…" : "Reindex"}
          </Button>
        </div>

        <div className="mb-3 flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="create a github issue"
              value={input}
              onChange={(e) => setInput((e.target as HTMLInputElement).value)}
              className="h-9 w-full pl-9 text-[13px]"
              onKeyDown={(e) => {
                if (e.key === "Enter") runSearch();
              }}
            />
          </div>
          <Button size="sm" onClick={runSearch} disabled={!input.trim()}>
            Search
          </Button>
        </div>

        <div className="mb-6 text-[12px] text-muted-foreground">
          {status ? (
            <>
              namespace <span className="font-mono">{status.namespace}</span> · indexed{" "}
              {status.indexed.toLocaleString()} · completed {status.completed.toLocaleString()} ·
              queued {status.queued.toLocaleString()} · running {status.running.toLocaleString()} ·
              errors {status.error.toLocaleString()}
              {status.skipped > 0 ? ` · skipped ${status.skipped.toLocaleString()}` : ""}
              {status.outdated > 0 ? ` · outdated ${status.outdated.toLocaleString()}` : ""}
            </>
          ) : (
            "index status unavailable"
          )}
          {notice ? <span className="ml-2 text-foreground">{notice}</span> : null}
        </div>

        {searchFailed ? (
          <div className="rounded-md border border-border px-4 py-8 text-center text-sm text-muted-foreground">
            Search failed.
          </div>
        ) : submitted.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
            Enter a query to search the tool catalog.
          </div>
        ) : searching ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">Searching…</div>
        ) : items.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
            No tools matched <span className="font-mono">{submitted}</span>. The index may be empty
            or still processing. Run a reindex if the catalog changed.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10 text-right">#</TableHead>
                <TableHead>Tool</TableHead>
                <TableHead className="w-32">Integration</TableHead>
                <TableHead className="w-24 text-right">Score</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item, i) => (
                <TableRow key={item.path}>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {i + 1}
                  </TableCell>
                  <TableCell>
                    <div className="font-mono text-[13px] text-foreground">{item.path}</div>
                    {item.description ? (
                      <div className="mt-0.5 line-clamp-1 text-[12px] text-muted-foreground">
                        {item.description}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-[12px] text-muted-foreground">
                    {item.integration}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[12px] tabular-nums text-muted-foreground">
                    {item.score.toFixed(4)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
