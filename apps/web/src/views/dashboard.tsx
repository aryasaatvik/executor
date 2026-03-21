import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useExecutions, useSources, type Execution, type Source } from "@executor/react";
import { LoadableBlock } from "../components/loadable";
import { SourceFavicon } from "../components/source-favicon";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { IconPlus, IconSources } from "../components/icons";
import { LocalMcpInstallCard } from "../components/local-mcp-install-card";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Status dot colors
// ---------------------------------------------------------------------------

const statusDotColor: Record<string, string> = {
  completed: "bg-emerald-500",
  failed: "bg-destructive",
  waiting_for_interaction: "bg-amber-500",
  running: "bg-blue-500",
  pending: "bg-blue-400",
  cancelled: "bg-muted-foreground/40",
};

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

function computeStats(executions: ReadonlyArray<Execution>) {
  const total = executions.length;
  let completed = 0;
  let failed = 0;
  let totalDuration = 0;
  let durationCount = 0;

  for (const exec of executions) {
    if (exec.status === "completed") {
      completed++;
      if (exec.startedAt != null && exec.completedAt != null) {
        totalDuration += exec.completedAt - exec.startedAt;
        durationCount++;
      }
    } else if (exec.status === "failed") {
      failed++;
    }
  }

  const avgDuration = durationCount > 0 ? totalDuration / durationCount : null;

  return { total, completed, failed, avgDuration };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function DashboardPage() {
  const executions = useExecutions();
  const sources = useSources();

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
        {/* Header */}
        <div>
          <h1 className="font-display text-3xl tracking-tight text-foreground lg:text-4xl">
            Dashboard
          </h1>
          <p className="mt-1.5 text-[14px] text-muted-foreground">
            Workspace activity overview
          </p>
        </div>

        <LoadableBlock loadable={executions} loading="Loading dashboard...">
          {(items) => <DashboardContent executions={items} />}
        </LoadableBlock>

        {/* Sources */}
        <section className="mt-8">
          <div className="flex items-end justify-between mb-4">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
              Sources
            </span>
            <Link to="/sources/add">
              <Button size="sm" variant="ghost">
                <IconPlus className="size-3.5" />
                Add source
              </Button>
            </Link>
          </div>

          <LoadableBlock loadable={sources} loading="Loading sources...">
            {(items) =>
              items.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-16">
                  <div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground mb-4">
                    <IconSources className="size-5" />
                  </div>
                  <p className="text-[14px] font-medium text-foreground/70 mb-1">
                    No sources yet
                  </p>
                  <p className="text-[13px] text-muted-foreground/60 mb-5">
                    Add a source to get started.
                  </p>
                  <Link to="/sources/add">
                    <Button size="sm">
                      <IconPlus className="size-3.5" />
                      Add source
                    </Button>
                  </Link>
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {items.map((source) => (
                    <SourceCard key={source.id} source={source} />
                  ))}
                </div>
              )
            }
          </LoadableBlock>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard content (rendered once data is ready)
// ---------------------------------------------------------------------------

function extractToolPaths(executions: ReadonlyArray<Execution>): { path: string; count: number }[] {
  const counts = new Map<string, number>();
  const toolPattern = /tools\.([\w.]+)\s*\(/g;

  for (const exec of executions) {
    const seen = new Set<string>();
    let match: RegExpExecArray | null;
    toolPattern.lastIndex = 0;
    while ((match = toolPattern.exec(exec.code)) !== null) {
      const path = match[1]!;
      if (!seen.has(path)) {
        seen.add(path);
        counts.set(path, (counts.get(path) ?? 0) + 1);
      }
    }
  }

  return [...counts.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

function DashboardContent({
  executions,
}: {
  executions: ReadonlyArray<Execution>;
}) {
  const { total, completed, failed, avgDuration } = computeStats(executions);
  const recent = executions.slice(0, 5);
  const topTools = useMemo(() => extractToolPaths(executions), [executions]);
  const maxToolCount = topTools.length > 0 ? topTools[0]!.count : 0;

  return (
    <>
      {/* Stats cards */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mt-8">
        <StatCard label="Total" value={String(total)} />
        <StatCard
          label="Completed"
          value={String(completed)}
          valueClassName="text-emerald-500"
        />
        <StatCard
          label="Failed"
          value={String(failed)}
          valueClassName="text-destructive"
        />
        <StatCard
          label="Avg Duration"
          value={avgDuration != null ? formatDuration(Math.round(avgDuration)) : "—"}
        />
      </div>

      {/* Top Tools */}
      <section className="mt-8 rounded-xl border border-border bg-card/60">
        <div className="border-b border-border px-4 py-3">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
            Top Tools
          </span>
        </div>
        {topTools.length === 0 ? (
          <div className="px-4 py-6">
            <p className="text-[13px] text-muted-foreground/50">
              Run executions to see tool analytics
            </p>
          </div>
        ) : (
          <div className="px-4 py-3 space-y-2">
            {topTools.map((tool) => (
              <div key={tool.path} className="flex items-center gap-3">
                <span className="w-52 shrink-0 truncate font-mono text-[12px] text-foreground/80" title={tool.path}>
                  {tool.path}
                </span>
                <div className="flex-1 h-5 rounded-sm bg-muted/40 overflow-hidden">
                  <div
                    className="h-full rounded-sm bg-primary/60"
                    style={{ width: `${(tool.count / maxToolCount) * 100}%` }}
                  />
                </div>
                <span className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                  {tool.count}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <LocalMcpInstallCard className="mt-8" />

      {/* Recent Executions */}
      <section className="mt-8 rounded-xl border border-border bg-card/60">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
            Recent Executions
          </span>
          <Link
            to="/executions"
            className="text-[11px] font-medium text-primary transition-colors hover:text-primary/80"
          >
            View all &rarr;
          </Link>
        </div>

        {recent.length === 0 ? (
          <div className="px-4 py-8 text-center text-[13px] text-muted-foreground/50">
            No executions yet.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {recent.map((exec) => (
              <ExecutionRow key={exec.id} execution={exec} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card/60 p-4">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
        {label}
      </p>
      <p
        className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${valueClassName ?? ""}`}
      >
        {value}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Execution row
// ---------------------------------------------------------------------------

function ExecutionRow({ execution }: { execution: Execution }) {
  const duration =
    execution.startedAt != null && execution.completedAt != null
      ? execution.completedAt - execution.startedAt
      : null;

  const truncatedCode =
    execution.code.length > 80
      ? execution.code.slice(0, 80) + "..."
      : execution.code;

  return (
    <Link
      to="/executions"
      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/30"
    >
      {/* Status dot */}
      <span
        className={`size-2 shrink-0 rounded-full ${statusDotColor[execution.status] ?? "bg-muted-foreground/30"}`}
        title={execution.status}
      />

      {/* Timestamp */}
      <span className="shrink-0 text-[11px] text-muted-foreground/60 tabular-nums w-14">
        {relativeTime(execution.createdAt)}
      </span>

      {/* Code snippet */}
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground/70">
        {truncatedCode}
      </span>

      {/* Duration */}
      {duration != null && (
        <span className="shrink-0 font-mono text-[12px] tabular-nums text-primary">
          {formatDuration(duration)}
        </span>
      )}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Source card
// ---------------------------------------------------------------------------

function SourceCard({ source }: { source: Source }) {
  return (
    <Link
      to="/sources/$sourceId"
      params={{ sourceId: source.id }}
      search={{ tab: "model" }}
      className="group flex flex-col rounded-xl border border-border bg-card p-4 transition-all hover:border-primary/30 hover:shadow-[0_2px_12px_-4px_rgba(0,0,0,0.12)]"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary">
          <SourceFavicon endpoint={source.endpoint} kind={source.kind} iconUrl={source.iconUrl} className="size-4.5" />
        </div>
        <Badge variant={source.status === "connected" ? "default" : source.status === "error" ? "destructive" : "muted"} className="shrink-0">
          {source.status}
        </Badge>
      </div>
      <h3 className="text-[14px] font-semibold text-foreground group-hover:text-primary transition-colors mb-0.5">
        {source.name}
      </h3>
      <div className="flex items-center gap-2 mt-auto pt-2">
        <Badge variant="outline" className="text-[9px]">{source.kind}</Badge>
      </div>
    </Link>
  );
}
