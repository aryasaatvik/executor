import { useState, useCallback } from "react";
import { cn } from "../lib/utils";
import { useExecutionSteps } from "@executor/react";
import type { Execution, ExecutionStep } from "@executor/react";
import { LoadableBlock } from "./loadable";
import { CodeBlock } from "./code-block";
import { IconClose, IconCopy, IconCheck, IconChevron } from "./icons";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const statusDotColor: Record<string, string> = {
  completed: "bg-emerald-500",
  failed: "bg-destructive",
  running: "bg-blue-500",
  pending: "bg-blue-500",
  waiting_for_interaction: "bg-amber-500",
  cancelled: "bg-muted-foreground",
};

const stepStatusDotColor: Record<string, string> = {
  completed: "bg-emerald-500",
  failed: "bg-destructive",
  pending: "bg-blue-500",
  waiting: "bg-amber-500",
};

const circledDigits = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];

function circledNumber(n: number): string {
  return circledDigits[n - 1] ?? `(${n})`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

type Tab = "properties" | "tool-calls" | "logs";

function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  const tabs: { key: Tab; label: string }[] = [
    { key: "properties", label: "Properties" },
    { key: "tool-calls", label: "Tool Calls" },
    { key: "logs", label: "Logs" },
  ];

  return (
    <div className="flex border-b border-border">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={cn(
            "px-4 py-2 font-mono text-[12px] border-b-2 transition-colors",
            active === t.key
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Property Row
// ---------------------------------------------------------------------------

function PropertyRow({ field, value }: { field: string; value: React.ReactNode }) {
  return (
    <div className="flex border-b border-border/50 py-2">
      <span className="w-40 shrink-0 text-muted-foreground font-mono text-[12px]">{field}</span>
      <span className="font-mono text-[12px] text-foreground break-all">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Properties Tab
// ---------------------------------------------------------------------------

function PropertiesTab({
  execution,
  showNullValues,
  onToggleNull,
}: {
  execution: Execution;
  showNullValues: boolean;
  onToggleNull: () => void;
}) {
  const durationMs =
    execution.startedAt != null && execution.completedAt != null
      ? execution.completedAt - execution.startedAt
      : null;

  const scalarRows: { field: string; value: React.ReactNode; isNull: boolean }[] = [
    {
      field: "status",
      value: (
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn("inline-block size-2 rounded-full", statusDotColor[execution.status] ?? "bg-muted-foreground")}
          />
          {execution.status}
        </span>
      ),
      isNull: false,
    },
    {
      field: "duration_ms",
      value: durationMs != null ? <span className="text-primary">{formatDuration(durationMs)}</span> : null,
      isNull: durationMs == null,
    },
    {
      field: "execution_id",
      value: execution.id,
      isNull: false,
    },
    {
      field: "error",
      value:
        execution.errorText != null ? (
          <span className="text-destructive">{execution.errorText}</span>
        ) : null,
      isNull: execution.errorText == null,
    },
    {
      field: "started_at",
      value: execution.startedAt != null ? formatTimestamp(execution.startedAt) : null,
      isNull: execution.startedAt == null,
    },
    {
      field: "completed_at",
      value: execution.completedAt != null ? formatTimestamp(execution.completedAt) : null,
      isNull: execution.completedAt == null,
    },
    {
      field: "created_at",
      value: formatTimestamp(execution.createdAt),
      isNull: false,
    },
  ];

  const visibleRows = showNullValues ? scalarRows : scalarRows.filter((r) => !r.isNull);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3">
      {visibleRows.map((r) => (
        <PropertyRow
          key={r.field}
          field={r.field}
          value={r.isNull ? <span className="text-muted-foreground/40 italic">null</span> : r.value}
        />
      ))}

      {/* Code — full-width syntax-highlighted block */}
      <div className="mt-3">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Code</div>
        <CodeBlock code={execution.code} lang="typescript" className="rounded-md border border-border/50 bg-muted/30" />
      </div>

      {/* Result — full-width syntax-highlighted block */}
      {(execution.resultJson != null || showNullValues) && (
        <div className="mt-3">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Result</div>
          {execution.resultJson != null ? (
            <CodeBlock code={tryFormatJson(execution.resultJson)} lang="json" className="rounded-md border border-border/50 bg-muted/30" />
          ) : (
            <span className="font-mono text-[12px] text-muted-foreground/40 italic">null</span>
          )}
        </div>
      )}

      <label className="mt-4 flex items-center gap-2 text-[12px] text-muted-foreground cursor-pointer select-none">
        <input
          type="checkbox"
          checked={showNullValues}
          onChange={onToggleNull}
          className="accent-primary"
        />
        Show null values
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collapsible Section
// ---------------------------------------------------------------------------

function CollapsibleJson({ label, json }: { label: string; json: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <IconChevron className={cn("size-3 transition-transform", open ? "rotate-90" : "")} />
        {label}
      </button>
      {open && (
        <CodeBlock code={tryFormatJson(json)} lang="json" className="mt-1 rounded-md border border-border/50 bg-muted/30" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool Calls Tab
// ---------------------------------------------------------------------------

function ToolCallsTab({ executionId }: { executionId: string }) {
  const steps = useExecutionSteps(executionId);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3">
      <LoadableBlock loadable={steps} loading="Loading steps...">
        {(data) =>
          data.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-[13px] text-muted-foreground/60">
              No tool calls recorded.
            </div>
          ) : (
            <div className="space-y-3">
              {data.map((step) => (
                <StepCard key={step.id} step={step} />
              ))}
            </div>
          )
        }
      </LoadableBlock>
    </div>
  );
}

function StepCard({ step }: { step: ExecutionStep }) {
  const durationMs =
    step.createdAt && step.updatedAt && step.status !== "pending"
      ? step.updatedAt - step.createdAt
      : null;

  return (
    <div className="rounded-md border border-border/50 bg-muted/30 p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[13px] text-muted-foreground">
          {circledNumber(step.sequence)}
        </span>
        <span
          className={cn(
            "inline-block size-2 rounded-full",
            stepStatusDotColor[step.status] ?? "bg-muted-foreground",
          )}
        />
        <span className="font-mono text-[12px] font-bold text-foreground">{step.path}</span>
        {durationMs != null && (
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">
            {formatDuration(durationMs)}
          </span>
        )}
      </div>
      <CollapsibleJson label="Args" json={step.argsJson} />
      {step.resultJson != null && <CollapsibleJson label="Result" json={step.resultJson} />}
      {step.errorText != null && (
        <div className="mt-1 font-mono text-[11px] text-destructive">{step.errorText}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Logs Tab
// ---------------------------------------------------------------------------

function LogsTab({ logsJson }: { logsJson: string | null }) {
  let lines: string[] = [];
  if (logsJson) {
    try {
      lines = JSON.parse(logsJson) as string[];
    } catch {
      lines = [logsJson];
    }
  }

  if (lines.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground/60">
        No logs captured for this execution.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3">
      <div className="space-y-0.5">
        {lines.map((line, i) => (
          <div key={i} className={cn("font-mono text-[12px] leading-relaxed", logLineColor(line))}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

function logLineColor(line: string): string {
  if (line.includes("[error]")) return "text-destructive";
  if (line.includes("[warn]")) return "text-amber-500";
  return "text-foreground";
}

// ---------------------------------------------------------------------------
// JSON helper
// ---------------------------------------------------------------------------

function tryFormatJson(raw: string): string {
  try {
    let parsed = JSON.parse(raw);
    // Unwrap double-encoded JSON strings
    while (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        break;
      }
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Main Drawer
// ---------------------------------------------------------------------------

interface ExecutionDetailDrawerProps {
  execution: Execution;
  onClose: () => void;
}

export function ExecutionDetailDrawer({ execution, onClose }: ExecutionDetailDrawerProps) {
  const [activeTab, setActiveTab] = useState<Tab>("properties");
  const [showNullValues, setShowNullValues] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopyJson = useCallback(() => {
    void navigator.clipboard.writeText(JSON.stringify(execution, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [execution]);

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-[60vw] max-w-3xl border-l border-border bg-card flex flex-col overflow-hidden shadow-2xl animate-in slide-in-from-right duration-200">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Execution
          </div>
          <div className="mt-0.5 font-mono text-[12px] text-foreground/70">
            {formatTimestamp(execution.createdAt)}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={handleCopyJson}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            title="Copy execution as JSON"
          >
            {copied ? (
              <>
                <IconCheck className="size-3" />
                Copied
              </>
            ) : (
              <>
                <IconCopy className="size-3" />
                Copy JSON
              </>
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:text-foreground transition-colors"
            title="Close"
          >
            <IconClose className="size-4" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <TabBar active={activeTab} onChange={setActiveTab} />

      {/* Content */}
      {activeTab === "properties" && (
        <PropertiesTab
          execution={execution}
          showNullValues={showNullValues}
          onToggleNull={() => setShowNullValues((v) => !v)}
        />
      )}
      {activeTab === "tool-calls" && <ToolCallsTab executionId={execution.id} />}
      {activeTab === "logs" && <LogsTab logsJson={execution.logsJson} />}
    </div>
  );
}
