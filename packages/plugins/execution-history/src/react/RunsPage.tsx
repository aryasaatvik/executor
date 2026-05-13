import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useMemo, useState } from "react";
import { useScope } from "@executor-js/react/api/scope-context";
import { Badge } from "@executor-js/react/components/badge";
import { Button } from "@executor-js/react/components/button";
import { Input } from "@executor-js/react/components/input";
import { ScrollArea } from "@executor-js/react/components/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@executor-js/react/components/select";
import { Separator } from "@executor-js/react/components/separator";

import type { ExecutionHistoryListItem, ExecutionHistoryRunStatus } from "../sdk";
import { runsAtom, runDetailAtom, runToolCallsAtom, type RunsQuery } from "./atoms";

const STATUS_OPTIONS = ["all", "running", "completed", "failed"] as const;
const INTERACTION_OPTIONS = ["all", "true", "false"] as const;
const PAGE_SIZE = 50;

const formatTime = (timestamp: number | null): string =>
  timestamp == null ? "Pending" : new Date(timestamp).toLocaleString();

const duration = (run: ExecutionHistoryListItem["execution"]): string => {
  if (run.completedAt == null) return "Running";
  const ms = Math.max(0, run.completedAt - run.startedAt);
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

const statusClass = (status: ExecutionHistoryRunStatus): string =>
  status === "completed"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    : status === "failed"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";

function JsonBlock(props: { readonly value: string | null }) {
  if (!props.value) return <p className="text-sm text-muted-foreground">None</p>;
  return (
    <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/35 p-3 text-xs leading-relaxed">
      {props.value}
    </pre>
  );
}

function RunDetail(props: { readonly runId: string | null }) {
  const scopeId = useScope();
  const detail = useAtomValue(runDetailAtom({ scopeId, runId: props.runId ?? "__none__" }));
  const toolCalls = useAtomValue(runToolCallsAtom({ scopeId, runId: props.runId ?? "__none__" }));

  if (!props.runId) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
        Select a run to inspect its code, output, and tool-call timeline.
      </div>
    );
  }

  return AsyncResult.match(detail, {
    onInitial: () => <div className="p-4 text-sm text-muted-foreground">Loading run…</div>,
    onFailure: () => <div className="p-4 text-sm text-destructive">Unable to load run.</div>,
    onSuccess: ({ value }) => {
      if (!value) return <div className="p-4 text-sm text-muted-foreground">Run not found.</div>;
      const run = value.execution;
      return (
        <ScrollArea className="h-full">
          <div className="space-y-5 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-mono text-xs text-muted-foreground">{run.id}</p>
                <h2 className="mt-1 text-lg font-semibold">Run detail</h2>
              </div>
              <Badge variant="outline" className={statusClass(run.status)}>
                {run.status}
              </Badge>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Started</p>
                <p>{formatTime(run.startedAt)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Duration</p>
                <p>{duration(run)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Trigger</p>
                <p>{run.triggerKind ?? "unknown"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Tools</p>
                <p>{run.toolCallCount}</p>
              </div>
            </div>

            <Separator />

            <section className="space-y-2">
              <h3 className="text-sm font-medium">Code</h3>
              <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/35 p-3 text-xs leading-relaxed">
                {run.code}
              </pre>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">Result</h3>
              <JsonBlock value={run.resultJson} />
              {run.errorText && <p className="text-sm text-destructive">{run.errorText}</p>}
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">Tool calls</h3>
              {AsyncResult.match(toolCalls, {
                onInitial: () => (
                  <p className="text-sm text-muted-foreground">Loading tool calls…</p>
                ),
                onFailure: () => (
                  <p className="text-sm text-destructive">Unable to load tool calls.</p>
                ),
                onSuccess: ({ value: toolCallResult }) =>
                  toolCallResult.toolCalls.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No tool calls recorded.</p>
                  ) : (
                    <div className="space-y-2">
                      {toolCallResult.toolCalls.map((toolCall) => (
                        <div key={toolCall.id} className="rounded-md border border-border p-3">
                          <div className="flex items-center justify-between gap-2">
                            <p className="truncate font-mono text-xs">{toolCall.toolPath}</p>
                            <Badge variant="outline" className={statusClass(toolCall.status)}>
                              {toolCall.status}
                            </Badge>
                          </div>
                          {toolCall.errorText && (
                            <p className="mt-2 text-sm text-destructive">{toolCall.errorText}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  ),
              })}
            </section>
          </div>
        </ScrollArea>
      );
    },
  });
}

export function RunsPage() {
  const scopeId = useScope();
  const [status, setStatus] = useState<(typeof STATUS_OPTIONS)[number]>("all");
  const [interaction, setInteraction] = useState<(typeof INTERACTION_OPTIONS)[number]>("all");
  const [tool, setTool] = useState("");
  const [code, setCode] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const query = useMemo<RunsQuery>(
    () => ({
      limit: PAGE_SIZE,
      status: status === "all" ? undefined : status,
      interaction: interaction === "all" ? undefined : interaction,
      tool: tool.trim() || undefined,
      code: code.trim() || undefined,
    }),
    [code, interaction, status, tool],
  );
  const runs = useAtomValue(runsAtom({ scopeId, query }));
  const refresh = useAtomRefresh(runsAtom({ scopeId, query }));

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_420px]">
      <div className="flex min-h-0 flex-col border-r border-border">
        <div className="shrink-0 border-b border-border p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Runs</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Local execution history from the execution-history plugin.
              </p>
            </div>
            <Button type="button" variant="outline" onClick={refresh}>
              Refresh
            </Button>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-[160px_160px_minmax(0,1fr)_minmax(0,1fr)]">
            <Select value={status} onValueChange={(value) => setStatus(value as typeof status)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option === "all" ? "All statuses" : option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={interaction}
              onValueChange={(value) => setInteraction(value as typeof interaction)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All interactions</SelectItem>
                <SelectItem value="true">With interaction</SelectItem>
                <SelectItem value="false">Without interaction</SelectItem>
              </SelectContent>
            </Select>
            <Input
              value={tool}
              onChange={(event) => setTool(event.target.value)}
              placeholder="Tool filter"
            />
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="Search code"
            />
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          {AsyncResult.match(runs, {
            onInitial: () => <div className="p-4 text-sm text-muted-foreground">Loading runs…</div>,
            onFailure: () => (
              <div className="p-4 text-sm text-destructive">Unable to load runs.</div>
            ),
            onSuccess: ({ value }) =>
              value.executions.length === 0 ? (
                <div className="p-8 text-sm text-muted-foreground">
                  No runs match the current filters.
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {value.executions.map((item) => {
                    const run = item.execution;
                    const selected = selectedRunId === run.id;
                    return (
                      <Button
                        key={run.id}
                        variant="ghost"
                        type="button"
                        onClick={() => setSelectedRunId(run.id)}
                        className={[
                          "grid w-full grid-cols-[minmax(0,1fr)_auto] gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/50",
                          selected ? "bg-muted" : "",
                        ].join(" ")}
                      >
                        <span className="min-w-0">
                          <span className="flex items-center gap-2">
                            <Badge variant="outline" className={statusClass(run.status)}>
                              {run.status}
                            </Badge>
                            <span className="truncate font-mono text-xs text-muted-foreground">
                              {run.id}
                            </span>
                          </span>
                          <span className="mt-2 block truncate text-sm">{run.code}</span>
                        </span>
                        <span className="text-right text-xs text-muted-foreground">
                          <span className="block">{duration(run)}</span>
                          <span className="block">{run.triggerKind ?? "unknown"}</span>
                          <span className="block">{run.toolCallCount} tools</span>
                        </span>
                      </Button>
                    );
                  })}
                </div>
              ),
          })}
        </ScrollArea>
      </div>
      <div className="min-h-0 border-t border-border lg:border-t-0">
        <RunDetail runId={selectedRunId} />
      </div>
    </div>
  );
}
