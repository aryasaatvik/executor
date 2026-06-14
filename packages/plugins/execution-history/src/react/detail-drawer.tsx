import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Badge } from "@executor-js/react/components/badge";
import { Button } from "@executor-js/react/components/button";
import { CodeBlock } from "@executor-js/react/components/code-block";
import { CopyButton } from "@executor-js/react/components/copy-button";
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

import type { InteractionRow, InteractionStatus, RunRow, ToolCallRow } from "../sdk/collections";
import { runDetailAtom, runToolCallsAtom } from "./atoms";
import { formatDateTime, formatDuration, logLines, prettyJson, statusLabel } from "./format";
import { HoverCardTimestamp } from "./hover-card-timestamp";
import { STATUS_TONES, triggerTone } from "./status";

// ---------------------------------------------------------------------------
// Right-side run detail drawer: a 3-tab Sheet (Properties / Tool calls / Logs)
// opened on row click. Properties carries the highlighted code + result + any
// pending interaction inline; Tool calls renders a timing waterfall. Code/JSON
// reuse the shared shiki `CodeBlock` from `@executor-js/react`. Reads detail +
// tool calls through the plugin's atoms; kept self-contained so the runs page
// and any other surface can mount it.
// ---------------------------------------------------------------------------

function MetaCard(props: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
      <p className="text-[10px] font-medium uppercase text-muted-foreground">{props.label}</p>
      <div className="mt-1 text-sm break-words">{props.children}</div>
    </div>
  );
}

/** Pretty-printed JSON in the shared highlighted code card, or an empty state. */
function JsonBlock(props: { readonly title: string; readonly value: string | null }) {
  const text = prettyJson(props.value);
  if (!text) {
    return (
      <div className="rounded-md border border-border bg-muted/25 px-4 py-8 text-center font-mono text-xs text-muted-foreground">
        No {props.title.toLowerCase()} recorded.
      </div>
    );
  }
  return <CodeBlock code={text} lang="json" title={props.title} />;
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

// ---------------------------------------------------------------------------
// Tool calls — timing waterfall
// ---------------------------------------------------------------------------

/** A single Gantt bar: offset + width as a percentage of the execution window. */
function ToolCallWaterfall(props: {
  readonly call: ToolCallRow;
  readonly windowStart: number;
  readonly windowEnd: number;
}) {
  const span = Math.max(1, props.windowEnd - props.windowStart);
  // Clamp the offset so a call starting at the very end of the window still
  // leaves room for the bar, then floor the width at 1% so it never collapses
  // to nothing (Math.min(100 - offsetPct, …) could otherwise hit 0).
  const offsetPct = Math.min(
    99,
    Math.max(0, ((props.call.startedAt - props.windowStart) / span) * 100),
  );
  const rawMs = props.call.durationMs ?? Math.max(0, props.windowEnd - props.call.startedAt);
  const widthPct = Math.max(1, Math.min(100 - offsetPct, (rawMs / span) * 100));
  const tone = STATUS_TONES[props.call.status];
  return (
    <span className="relative h-4 w-40 shrink-0 overflow-hidden rounded-sm border border-border/40 bg-muted/30">
      <span
        className={cn("absolute inset-y-0 rounded-[2px]", tone.dot, tone.pulse && "animate-pulse")}
        style={{ left: `${offsetPct}%`, width: `${widthPct}%` }}
      />
    </span>
  );
}

function ToolCallItem(props: {
  readonly call: ToolCallRow;
  readonly windowStart: number;
  readonly windowEnd: number;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="overflow-hidden rounded-md border border-border bg-muted/20">
      <Button
        type="button"
        variant="ghost"
        onClick={() => setExpanded((value) => !value)}
        className="grid h-auto w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-none px-3 py-2 text-left"
      >
        <ToolCallWaterfall
          call={props.call}
          windowStart={props.windowStart}
          windowEnd={props.windowEnd}
        />
        <span className="min-w-0 truncate font-mono text-xs">{props.call.path}</span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {props.call.durationMs != null ? `${props.call.durationMs}ms` : "—"}
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

function ToolCallsTab(props: { readonly run: RunRow }) {
  const toolCalls = useAtomValue(runToolCallsAtom(props.run.executionId));
  const windowStart = props.run.startedAt;
  return AsyncResult.match(toolCalls, {
    onInitial: () => <p className="text-sm text-muted-foreground">Loading tool calls...</p>,
    onFailure: () => <p className="text-sm text-destructive">Unable to load tool calls.</p>,
    onSuccess: ({ value }) => {
      if (value.toolCalls.length === 0) {
        return <p className="text-sm text-muted-foreground">No tool calls recorded.</p>;
      }
      // Derive the window end from the tool-call data rather than only
      // `run.completedAt` — the two atoms refresh independently, so a fresher
      // tool call can outrun a stale run end; covering it here avoids clamping
      // that bar to a 1% sliver.
      const callsEnd = value.toolCalls.reduce(
        (max, call) =>
          Math.max(
            max,
            call.completedAt ??
              (call.durationMs != null ? call.startedAt + call.durationMs : call.startedAt),
          ),
        windowStart,
      );
      const windowEnd = Math.max(props.run.completedAt ?? Date.now(), callsEnd);
      return (
        <div className="space-y-2">
          {value.toolCalls.map((call) => (
            <ToolCallItem
              key={call.toolCallId}
              call={call}
              windowStart={windowStart}
              windowEnd={windowEnd}
            />
          ))}
        </div>
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Interactions (elicitations) — rendered inline on the Properties tab
// ---------------------------------------------------------------------------

const INTERACTION_BADGE: Record<InteractionStatus, string> = {
  pending: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  accepted: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  declined: "border-border bg-muted/30 text-muted-foreground",
  cancelled: "border-border bg-muted/30 text-muted-foreground",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
};

const interactionKindLabel = (kind: string): string =>
  kind === "UrlElicitation" ? "url" : kind === "FormElicitation" ? "form" : kind;

function InteractionBlock(props: { readonly interaction: InteractionRow }) {
  const { interaction } = props;
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-sm">
          <span className="text-muted-foreground">{interactionKindLabel(interaction.kind)}</span>
          {interaction.purpose ? (
            <span className="ml-2 font-mono text-xs break-all">{interaction.purpose}</span>
          ) : null}
        </p>
        <Badge
          variant="outline"
          className={cn(
            "shrink-0 font-mono text-[10px] uppercase tracking-wider",
            INTERACTION_BADGE[interaction.status],
          )}
        >
          {interaction.status}
        </Badge>
      </div>
      <JsonBlock title="Request" value={interaction.payloadJson} />
      <JsonBlock title="Response" value={interaction.responseJson} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drawer shell + content
// ---------------------------------------------------------------------------

function DetailContent(props: {
  readonly run: RunRow;
  readonly interactions: readonly InteractionRow[];
  readonly onPrev?: () => void;
  readonly onNext?: () => void;
}) {
  const { run } = props;
  const tone = STATUS_TONES[run.status];
  const trigger = triggerTone(run.triggerKind);
  const pendingCount = props.interactions.filter(
    (interaction) => interaction.status === "pending",
  ).length;
  // Singular/plural only when every interaction is pending; a mix gets the
  // neutral "Interactions" so the heading never misrepresents the block.
  const interactionsHeading =
    pendingCount > 0 && pendingCount === props.interactions.length
      ? pendingCount === 1
        ? "Pending interaction"
        : "Pending interactions"
      : "Interactions";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeader className="border-b border-border px-5 py-3">
        <div className="flex items-center gap-2 pr-8">
          <SheetTitle className="min-w-0 flex-1 truncate font-mono text-sm">
            {run.executionId}
          </SheetTitle>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={props.onPrev == null}
              onClick={props.onPrev}
              title="Previous run"
            >
              <ChevronUp />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={props.onNext == null}
              onClick={props.onNext}
              title="Next run"
            >
              <ChevronDown />
            </Button>
            <CopyButton
              value={JSON.stringify(run, null, 2)}
              label="Copy JSON"
              className="ml-1 uppercase"
            />
          </div>
        </div>
        <SheetDescription className="sr-only">
          {statusLabel(run.status)} run detail
        </SheetDescription>
      </SheetHeader>

      {/* Key by run so prev/next nav remounts the tabs and resets to Properties
          rather than stranding the user on an empty tab from the prior run. */}
      <Tabs key={run.executionId} defaultValue="properties" className="min-h-0 flex-1 gap-0">
        <TabsList variant="line" className="mx-5 mt-3">
          <TabsTrigger value="properties">Properties</TabsTrigger>
          <TabsTrigger value="tools">
            Tool calls{run.toolCallCount > 0 ? ` · ${run.toolCallCount}` : ""}
          </TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>
        <ScrollArea className="min-h-0 flex-1 px-5 py-4">
          <TabsContent value="properties" className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <MetaCard label="Status">
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      tone.dot,
                      tone.pulse && "animate-pulse",
                    )}
                  />
                  <span className={tone.text}>{statusLabel(run.status)}</span>
                </span>
              </MetaCard>
              <MetaCard label="Duration">
                {run.durationMs != null ? formatDuration(run.durationMs) : "—"}
              </MetaCard>
              <MetaCard label="Actor">
                {run.actorId !== null ? (
                  <span className="font-mono text-xs break-all">
                    {run.actorLabel ?? run.actorId}
                    {run.actorKind !== null ? (
                      <span className="text-muted-foreground/60"> · {run.actorKind}</span>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-muted-foreground/60">—</span>
                )}
              </MetaCard>
              <MetaCard label="Started">
                <HoverCardTimestamp timestamp={run.startedAt} side="bottom" />
              </MetaCard>
              <MetaCard label="Completed">
                {run.completedAt != null ? (
                  <HoverCardTimestamp timestamp={run.completedAt} side="bottom" />
                ) : (
                  formatDateTime(run.completedAt)
                )}
              </MetaCard>
            </div>

            <div className="flex items-center gap-2 text-xs">
              <span className="flex items-center gap-1.5">
                <span className={cn("size-1.5 shrink-0 rounded-full", trigger.dot)} />
                <span className={trigger.text}>via {trigger.label}</span>
              </span>
              <span className="text-muted-foreground">· tools {run.toolCallCount}</span>
            </div>

            <CodeBlock code={run.code} lang="typescript" title="Code" />
            <JsonBlock title="Result" value={run.resultJson} />
            {run.errorText && (
              <div className="space-y-1">
                <p className="text-[10px] font-medium uppercase text-muted-foreground">Error</p>
                <pre className="rounded-md border border-destructive/30 bg-destructive/10 p-3 font-mono text-xs whitespace-pre-wrap">
                  {run.errorText}
                </pre>
              </div>
            )}

            {props.interactions.length > 0 && (
              <div className="space-y-2">
                <p className="text-[10px] font-medium uppercase text-muted-foreground">
                  {interactionsHeading}
                </p>
                {props.interactions.map((interaction) => (
                  <InteractionBlock key={interaction.interactionId} interaction={interaction} />
                ))}
              </div>
            )}
          </TabsContent>
          <TabsContent value="tools">
            <ToolCallsTab run={run} />
          </TabsContent>
          <TabsContent value="logs">
            <LogsBlock logsJson={run.logsJson} />
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </div>
  );
}

/** Reads the detail atom — split out so the query only fires for a real id
 *  (never the closed/sentinel state) and runs solely while the drawer is open. */
function DetailLoader(props: {
  readonly executionId: string;
  readonly onPrev?: () => void;
  readonly onNext?: () => void;
}) {
  const detail = useAtomValue(runDetailAtom(props.executionId));
  return AsyncResult.match(detail, {
    onInitial: () => <div className="p-5 text-sm text-muted-foreground">Loading run...</div>,
    onFailure: () => <div className="p-5 text-sm text-destructive">Unable to load run.</div>,
    onSuccess: ({ value }) =>
      value ? (
        <DetailContent
          run={value.run}
          interactions={value.interactions}
          onPrev={props.onPrev}
          onNext={props.onNext}
        />
      ) : (
        <div className="p-5 text-sm text-muted-foreground">Run not found.</div>
      ),
  });
}

export function DetailDrawer(props: {
  readonly executionId: string | null;
  readonly onClose: () => void;
  readonly onPrev?: () => void;
  readonly onNext?: () => void;
}) {
  return (
    <Sheet open={props.executionId != null} onOpenChange={(open) => !open && props.onClose()}>
      <SheetContent side="right" showCloseButton className="w-full gap-0 p-0 sm:max-w-3xl">
        {props.executionId == null ? null : (
          <DetailLoader
            executionId={props.executionId}
            onPrev={props.onPrev}
            onNext={props.onNext}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
