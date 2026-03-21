import { useState, useMemo } from "react";
import { useExecutions, type Execution } from "@executor/react";
import { cn } from "../lib/utils";
import { LoadableBlock } from "../components/loadable";
import { ExecutionDetailDrawer } from "../components/execution-detail-drawer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const statusDotColor: Record<string, string> = {
  completed: "bg-emerald-500",
  failed: "bg-destructive",
  running: "bg-blue-500",
  pending: "bg-blue-500",
  waiting_for_interaction: "bg-amber-400",
  cancelled: "bg-muted-foreground/30",
};

const statusTextColor = (status: string): string => {
  const map: Record<string, string> = {
    completed: "text-emerald-500",
    failed: "text-destructive",
    running: "text-blue-500",
    pending: "text-blue-500",
    waiting_for_interaction: "text-amber-400",
  };
  return map[status] ?? "text-foreground";
};

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const month = d.toLocaleString("en-US", { month: "short" });
  const day = d.getDate().toString().padStart(2, "0");
  const time = d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return `${month} ${day}, ${time}`;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "\u2026";
}

// ---------------------------------------------------------------------------
// Stream row
// ---------------------------------------------------------------------------

function ExecutionStreamRow({
  execution,
  selected,
  onSelect,
}: {
  execution: Execution;
  selected: boolean;
  onSelect: () => void;
}) {
  const duration =
    execution.completedAt && execution.startedAt
      ? execution.completedAt - execution.startedAt
      : null;

  return (
    <button
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 border-b border-border/30 px-6 py-2 text-left font-mono text-[12px] leading-relaxed transition-colors hover:bg-white/[0.04]",
        selected && "bg-white/[0.06]",
      )}
    >
      {/* Status dot */}
      <span
        className={cn(
          "mt-1.5 size-2 shrink-0 rounded-full",
          statusDotColor[execution.status] ?? "bg-muted-foreground/30",
        )}
      />

      {/* Timestamp */}
      <span className="w-36 shrink-0 tabular-nums text-muted-foreground">
        {formatTimestamp(execution.createdAt)}
      </span>

      {/* Raw data — Axiom style key:value pairs */}
      <span className="flex-1 break-all">
        <span className="text-muted-foreground">status:</span>{" "}
        <span className={statusTextColor(execution.status)}>
          {execution.status === "waiting_for_interaction"
            ? "waiting"
            : execution.status}
        </span>
        {"  "}
        {duration !== null && (
          <>
            <span className="text-muted-foreground">duration_ms:</span>{" "}
            <span className="text-primary">{duration.toLocaleString()}</span>
            {"  "}
          </>
        )}
        <span className="text-muted-foreground">code:</span>{" "}
        <span className="text-foreground">
          &quot;{truncate(execution.code, 60)}&quot;
        </span>
        {execution.errorText && (
          <>
            {"  "}
            <span className="text-muted-foreground">error:</span>{" "}
            <span className="text-destructive">
              &quot;{truncate(execution.errorText, 40)}&quot;
            </span>
          </>
        )}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ExecutionsPage() {
  const executions = useExecutions();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");

  const filtered = useMemo(() => {
    if (executions.status !== "ready") return [];
    let items = executions.data as ReadonlyArray<Execution>;

    if (statusFilter !== "all") {
      items = items.filter((e) => e.status === statusFilter);
    }

    if (searchQuery.trim().length > 0) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (e) =>
          e.code.toLowerCase().includes(q) ||
          (e.errorText && e.errorText.toLowerCase().includes(q)),
      );
    }

    return items;
  }, [executions, statusFilter, searchQuery]);

  const selectedExecution = useMemo(
    () =>
      selectedId && executions.status === "ready"
        ? (executions.data.find((e) => e.id === selectedId) ?? null)
        : null,
    [executions, selectedId],
  );

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Filter bar */}
      <div className="shrink-0 border-b border-border px-6 py-3 flex items-center gap-3">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-card border border-border rounded-md px-2 py-1.5 text-[12px] font-mono text-foreground"
        >
          <option value="all">All</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="running">Running</option>
          <option value="waiting_for_interaction">Waiting</option>
          <option value="pending">Pending</option>
          <option value="cancelled">Cancelled</option>
        </select>

        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search executions..."
          className="flex-1 bg-transparent text-[12px] font-mono text-foreground placeholder:text-muted-foreground/50 outline-none"
        />
      </div>

      {/* Stream container */}
      <LoadableBlock loadable={executions} loading="Loading executions...">
        {() => (
          <div className="flex-1 overflow-y-auto">
            {/* Column header */}
            <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background px-6 py-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              <span className="size-2 shrink-0" />
              <span className="w-36 shrink-0">_time</span>
              <span className="flex-1">Raw Data</span>
            </div>

            {filtered.length === 0 ? (
              <div className="flex items-center justify-center py-20 text-[13px] text-muted-foreground/60 font-mono">
                No executions found.
              </div>
            ) : (
              filtered.map((execution) => (
                <ExecutionStreamRow
                  key={execution.id}
                  execution={execution}
                  selected={execution.id === selectedId}
                  onSelect={() =>
                    setSelectedId(
                      execution.id === selectedId ? null : execution.id,
                    )
                  }
                />
              ))
            )}
          </div>
        )}
      </LoadableBlock>

      {/* Detail drawer overlay */}
      {selectedExecution && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40"
            onClick={() => setSelectedId(null)}
          />
          <ExecutionDetailDrawer
            execution={selectedExecution}
            onClose={() => setSelectedId(null)}
          />
        </>
      )}
    </div>
  );
}
