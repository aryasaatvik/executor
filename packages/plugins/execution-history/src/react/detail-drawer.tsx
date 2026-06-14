import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useState } from "react";
import { Badge } from "@executor-js/react/components/badge";
import { Button } from "@executor-js/react/components/button";
import { ScrollArea } from "@executor-js/react/components/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@executor-js/react/components/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@executor-js/react/components/tabs";
import { cn } from "@executor-js/react/lib/utils";

import type {
  InteractionRow,
  RunRow,
  RunStatus,
  ToolCallRow,
  ToolCallStatus,
} from "../sdk/collections";
import { runDetailAtom, runToolCallsAtom } from "./atoms";
import { formatDateTime, formatDuration, logLines, prettyJson, statusLabel } from "./format";
import { STATUS_TONES } from "./status";

// ---------------------------------------------------------------------------
// Right-side run detail drawer: a 4-tab Sheet (Properties / Tool calls / Logs /
// Interaction) opened on row click. Reads detail + tool calls through the
// plugin's atoms. Kept as a self-contained module so the runs page and any
// other surface can mount it.
// ---------------------------------------------------------------------------

export function StatusBadge(props: { readonly status: RunStatus | ToolCallStatus }) {
  return (
    <Badge variant="outline" className={STATUS_TONES[props.status].badge}>
      {statusLabel(props.status)}
    </Badge>
  );
}

function MetaCard(props: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
      <p className="text-[10px] font-medium uppercase text-muted-foreground">{props.label}</p>
      <div className="mt-1 text-sm break-words">{props.children}</div>
    </div>
  );
}

function JsonBlock(props: { readonly title: string; readonly value: string | null }) {
  const text = prettyJson(props.value);
  if (!text) {
    return (
      <div className="rounded-md border border-border bg-muted/25 px-4 py-8 text-center font-mono text-xs text-muted-foreground">
        No {props.title.toLowerCase()} recorded.
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-medium uppercase text-muted-foreground">{props.title}</p>
      <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/25 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
        {text}
      </pre>
    </div>
  );
}

function CodeBlock(props: { readonly code: string }) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-medium uppercase text-muted-foreground">Code</p>
      <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/25 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
        {props.code}
      </pre>
    </div>
  );
}

function LogsBlock(props: { readonly logsJson: string | null }) {
  const lines = logLines(props.logsJson);
  if (lines.length === 0) {
    return (
      <div className="rounded-md border border-border bg-muted/25 px-4 py-10 text-center font-mono text-xs text-muted-foreground">
        No logs recorded.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border border-border bg-muted/25">
      {lines.map((line, index) => (
        <pre
          key={`${index}-${line.slice(0, 24)}`}
          className={cn(
            "border-b border-border/40 px-3 py-1.5 font-mono text-xs whitespace-pre-wrap last:border-b-0",
            line.includes("[error]") && "text-destructive",
            line.includes("[warn]") && "text-amber-600 dark:text-amber-300",
          )}
        >
          {line}
        </pre>
      ))}
    </div>
  );
}

function ToolCallItem(props: { readonly call: ToolCallRow }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="overflow-hidden rounded-md border border-border bg-muted/20">
      <Button
        type="button"
        variant="ghost"
        onClick={() => setExpanded((value) => !value)}
        className="grid h-auto w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-none px-3 py-2 text-left"
      >
        <span className="min-w-0 truncate font-mono text-xs">{props.call.path}</span>
        <span className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-muted-foreground">
            {formatDuration(props.call.durationMs)}
          </span>
          <StatusBadge status={props.call.status} />
        </span>
      </Button>
      {expanded && (
        <div className="grid gap-3 border-t border-border p-3 xl:grid-cols-2">
          <JsonBlock title="Args" value={props.call.argsJson} />
          {props.call.status === "failed" && props.call.errorText ? (
            <div className="space-y-1">
              <p className="text-[10px] font-medium uppercase text-muted-foreground">Error</p>
              <pre className="max-h-72 overflow-auto rounded-md border border-destructive/30 bg-destructive/10 p-3 font-mono text-xs whitespace-pre-wrap">
                {props.call.errorText}
              </pre>
            </div>
          ) : (
            <JsonBlock title="Result" value={props.call.resultJson} />
          )}
        </div>
      )}
    </div>
  );
}

function ToolCallsTab(props: { readonly executionId: string }) {
  const toolCalls = useAtomValue(runToolCallsAtom(props.executionId));
  return AsyncResult.match(toolCalls, {
    onInitial: () => <p className="text-sm text-muted-foreground">Loading tool calls...</p>,
    onFailure: () => <p className="text-sm text-destructive">Unable to load tool calls.</p>,
    onSuccess: ({ value }) =>
      value.toolCalls.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tool calls recorded.</p>
      ) : (
        <div className="space-y-2">
          {value.toolCalls.map((call) => (
            <ToolCallItem key={call.toolCallId} call={call} />
          ))}
        </div>
      ),
  });
}

function InteractionTab(props: { readonly interactions: readonly InteractionRow[] }) {
  if (props.interactions.length === 0) {
    return (
      <div className="rounded-md border border-border bg-muted/25 px-4 py-10 text-center font-mono text-xs text-muted-foreground">
        No interactions recorded.
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {props.interactions.map((interaction) => (
        <div
          key={interaction.interactionId}
          className="space-y-3 rounded-md border border-border p-3"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <MetaCard label="Kind">{interaction.kind}</MetaCard>
            <MetaCard label="Status">{interaction.status}</MetaCard>
            <MetaCard label="Purpose">{interaction.purpose ?? "—"}</MetaCard>
          </div>
          <JsonBlock title="Request" value={interaction.payloadJson} />
          <JsonBlock title="Response" value={interaction.responseJson} />
        </div>
      ))}
    </div>
  );
}

function DetailContent(props: {
  readonly run: RunRow;
  readonly interactions: readonly InteractionRow[];
}) {
  const { run } = props;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeader className="border-b border-border px-5 py-3">
        <SheetTitle className="truncate font-mono text-sm">{run.executionId}</SheetTitle>
        <SheetDescription>
          {statusLabel(run.status)} / {run.triggerKind ?? "unknown"} /{" "}
          {formatDuration(run.durationMs)}
        </SheetDescription>
      </SheetHeader>

      <Tabs defaultValue="properties" className="min-h-0 flex-1 gap-0">
        <TabsList variant="line" className="mx-5 mt-3">
          <TabsTrigger value="properties">Properties</TabsTrigger>
          <TabsTrigger value="tools">Tool calls</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="interaction">Interaction</TabsTrigger>
        </TabsList>
        <ScrollArea className="min-h-0 flex-1 px-5 py-4">
          <TabsContent value="properties" className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <MetaCard label="Execution ID">
                <span className="font-mono text-xs break-all">{run.executionId}</span>
              </MetaCard>
              <MetaCard label="Status">
                <StatusBadge status={run.status} />
              </MetaCard>
              <MetaCard label="Trigger">{run.triggerKind ?? "unknown"}</MetaCard>
              <MetaCard label="Duration">{formatDuration(run.durationMs)}</MetaCard>
              <MetaCard label="Started">{formatDateTime(run.startedAt)}</MetaCard>
              <MetaCard label="Completed">{formatDateTime(run.completedAt)}</MetaCard>
            </div>
            <CodeBlock code={run.code} />
            <JsonBlock title="Result" value={run.resultJson} />
            {run.errorText && (
              <div className="space-y-1">
                <p className="text-[10px] font-medium uppercase text-muted-foreground">Error</p>
                <pre className="rounded-md border border-destructive/30 bg-destructive/10 p-3 font-mono text-xs whitespace-pre-wrap">
                  {run.errorText}
                </pre>
              </div>
            )}
          </TabsContent>
          <TabsContent value="tools">
            <ToolCallsTab executionId={run.executionId} />
          </TabsContent>
          <TabsContent value="logs">
            <LogsBlock logsJson={run.logsJson} />
          </TabsContent>
          <TabsContent value="interaction">
            <InteractionTab interactions={props.interactions} />
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </div>
  );
}

export function DetailDrawer(props: {
  readonly executionId: string | null;
  readonly onClose: () => void;
}) {
  const detail = useAtomValue(runDetailAtom(props.executionId ?? "__none__"));
  return (
    <Sheet open={props.executionId != null} onOpenChange={(open) => !open && props.onClose()}>
      <SheetContent side="right" showCloseButton className="w-full gap-0 p-0 sm:max-w-3xl">
        {props.executionId == null
          ? null
          : AsyncResult.match(detail, {
              onInitial: () => (
                <div className="p-5 text-sm text-muted-foreground">Loading run...</div>
              ),
              onFailure: () => (
                <div className="p-5 text-sm text-destructive">Unable to load run.</div>
              ),
              onSuccess: ({ value }) =>
                value ? (
                  <DetailContent run={value.run} interactions={value.interactions} />
                ) : (
                  <div className="p-5 text-sm text-muted-foreground">Run not found.</div>
                ),
            })}
      </SheetContent>
    </Sheet>
  );
}
