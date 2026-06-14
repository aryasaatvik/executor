import * as React from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@executor-js/react/components/accordion";
import { Button } from "@executor-js/react/components/button";
import { cn } from "@executor-js/react/lib/utils";

import type { ExecutionListMeta } from "../sdk/store";
import {
  STATUS_ORDER,
  STATUS_LABELS,
  TRIGGER_ORDER,
  actorTone,
  statusTone,
  triggerTone,
} from "./status";
import type { RunsFilters } from "./use-runs-list";

// ---------------------------------------------------------------------------
// Time range presets
// ---------------------------------------------------------------------------

export interface TimeRangePreset {
  readonly key: string;
  readonly label: string;
  readonly ms: number | null;
}

export const TIME_RANGE_PRESETS: readonly TimeRangePreset[] = [
  { key: "1h", label: "Last 1h", ms: 60 * 60 * 1000 },
  { key: "24h", label: "Last 24h", ms: 24 * 60 * 60 * 1000 },
  { key: "7d", label: "Last 7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "30d", label: "Last 30d", ms: 30 * 24 * 60 * 60 * 1000 },
  { key: "all", label: "All time", ms: null },
];

export const resolveTimeRange = (key: string): { from: number | null; to: number | null } => {
  const preset = TIME_RANGE_PRESETS.find((p) => p.key === key);
  if (!preset || preset.ms === null) return { from: null, to: null };
  const now = Date.now();
  return { from: now - preset.ms, to: now };
};

/** Best-effort match of the current from/to values against a known preset key. */
const activePresetKey = (from: number | null, to: number | null): string | null => {
  if (from === null && to === null) return "all";
  if (from === null || to === null) return null;
  const delta = to - from;
  for (const preset of TIME_RANGE_PRESETS) {
    if (preset.ms !== null && Math.abs(delta - preset.ms) < 60_000) return preset.key;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toggle = <T,>(arr: readonly T[], item: T): readonly T[] =>
  arr.includes(item) ? arr.filter((v) => v !== item) : [...arr, item];

const isFiltersActive = (filters: RunsFilters): boolean =>
  filters.status.length > 0 ||
  filters.trigger.length > 0 ||
  filters.actor.length > 0 ||
  filters.interaction !== null ||
  filters.from !== null ||
  filters.to !== null;

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function FacetSection({
  value,
  label,
  children,
}: {
  readonly value: string;
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <AccordionItem value={value} className="border-b border-border/40 last:border-b-0">
      <AccordionTrigger className="py-2 px-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 hover:no-underline hover:text-foreground">
        {label}
      </AccordionTrigger>
      <AccordionContent className="pb-2 pt-0 px-2">{children}</AccordionContent>
    </AccordionItem>
  );
}

function FacetRow({
  checked,
  onToggle,
  onOnly,
  dotClass,
  pulse,
  label,
  count,
  monoLabel,
}: {
  readonly checked: boolean;
  readonly onToggle: () => void;
  readonly onOnly?: () => void;
  readonly dotClass: string;
  readonly pulse?: boolean;
  readonly label: string;
  readonly count: number | undefined;
  readonly monoLabel?: boolean;
}) {
  return (
    <div className="group relative flex items-center">
      <Button
        type="button"
        variant="ghost"
        onClick={onToggle}
        className={cn(
          "h-auto w-full justify-start flex flex-1 items-center gap-2.5 py-1 text-left text-xs",
          "text-muted-foreground hover:text-foreground hover:bg-transparent",
          checked && "text-foreground",
        )}
      >
        <span
          className={cn(
            "inline-flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border border-border",
            checked && "border-foreground bg-foreground/10",
          )}
          aria-hidden
        >
          {checked ? (
            <svg viewBox="0 0 12 12" className="size-2.5 text-foreground">
              <path
                d="M2 6l3 3 5-6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : null}
        </span>

        <span
          aria-hidden
          className={cn("size-2 shrink-0 rounded-full", dotClass, pulse && "animate-pulse")}
        />

        <span className={cn("flex-1 truncate", monoLabel && "font-mono text-[11px]")}>{label}</span>

        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/50">
          {count ?? ""}
        </span>
      </Button>

      {onOnly ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onOnly();
          }}
          className={cn(
            "absolute right-0 hidden h-full items-center rounded-sm bg-background px-1.5",
            "font-mono text-[9px] uppercase tracking-wider text-muted-foreground/70",
            "hover:text-foreground hover:bg-transparent group-hover:flex",
          )}
          title="Filter to only this value"
        >
          only
        </Button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export interface RunsFilterRailProps {
  readonly filters: RunsFilters;
  readonly meta: ExecutionListMeta | null;
  readonly onChange: (filters: RunsFilters) => void;
  readonly onReset: () => void;
}

export function RunsFilterRail({ filters, meta, onChange, onReset }: RunsFilterRailProps) {
  const filtersActive = isFiltersActive(filters);

  const triggerKeys = React.useMemo(() => {
    const set = new Set<string>(TRIGGER_ORDER);
    if (meta?.triggerCounts) {
      for (const entry of meta.triggerCounts) {
        if (entry.triggerKind != null) set.add(entry.triggerKind);
      }
    }
    return [...set];
  }, [meta?.triggerCounts]);

  const currentPresetKey = activePresetKey(filters.from, filters.to);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-border border-b px-4 py-5">
        <h1 className="font-display text-xl tracking-tight text-foreground">Execution history</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Every execution recorded for this scope, newest first.
        </p>
        {meta ? (
          <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
            {meta.filterRowCount.toLocaleString()} of {meta.totalRowCount.toLocaleString()} runs
          </p>
        ) : null}
      </div>

      {/* Filters label + reset */}
      <div className="flex items-center justify-between border-border/60 border-b px-4 py-2">
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Filters
        </p>
        {filtersActive ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onReset}
            className="h-auto p-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 hover:text-foreground hover:bg-transparent"
          >
            Reset
          </Button>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        <Accordion
          type="multiple"
          defaultValue={["status", "trigger", "actor", "interaction", "time-range"]}
          className="w-full"
        >
          {/* Status facet */}
          <FacetSection value="status" label="Status">
            <ul className="space-y-0">
              {STATUS_ORDER.map((status) => {
                const tone = statusTone(status);
                const checked = filters.status.includes(status);
                const count = meta?.statusCounts.find((c) => c.status === status)?.count;
                return (
                  <li key={status}>
                    <FacetRow
                      checked={checked}
                      onToggle={() =>
                        onChange({ ...filters, status: toggle(filters.status, status) })
                      }
                      onOnly={() => onChange({ ...filters, status: [status] })}
                      dotClass={tone.dot}
                      pulse={tone.pulse}
                      label={STATUS_LABELS[status]}
                      count={count}
                    />
                  </li>
                );
              })}
            </ul>
          </FacetSection>

          {/* Trigger facet */}
          <FacetSection value="trigger" label="Trigger">
            <ul className="space-y-0">
              {triggerKeys.map((key) => {
                const tone = triggerTone(key);
                const checked = filters.trigger.includes(key);
                const count = meta?.triggerCounts.find((c) => c.triggerKind === key)?.count;
                return (
                  <li key={key}>
                    <FacetRow
                      checked={checked}
                      onToggle={() =>
                        onChange({ ...filters, trigger: toggle(filters.trigger, key) })
                      }
                      onOnly={() => onChange({ ...filters, trigger: [key] })}
                      dotClass={tone.dot}
                      label={tone.label}
                      count={count}
                      monoLabel
                    />
                  </li>
                );
              })}
            </ul>
          </FacetSection>

          {/* Actor facet — dynamic keys (token client ids / user subjects) from
              the run set; only filterable (non-null) actors are shown. */}
          {meta?.actorCounts && meta.actorCounts.some((entry) => entry.actorId !== null) ? (
            <FacetSection value="actor" label="Actor">
              <ul className="space-y-0">
                {meta.actorCounts.map((entry) => {
                  const id = entry.actorId;
                  // null actor (unattributed runs) isn't filterable — skip it.
                  if (id === null) return null;
                  const tone = actorTone(entry.actorKind);
                  const checked = filters.actor.includes(id);
                  return (
                    <li key={id}>
                      <FacetRow
                        checked={checked}
                        onToggle={() => onChange({ ...filters, actor: toggle(filters.actor, id) })}
                        onOnly={() => onChange({ ...filters, actor: [id] })}
                        dotClass={tone.dot}
                        label={entry.actorLabel ?? id}
                        count={entry.count}
                        monoLabel
                      />
                    </li>
                  );
                })}
              </ul>
            </FacetSection>
          ) : null}

          {/* Interaction facet */}
          <FacetSection value="interaction" label="Interactions">
            <ul className="space-y-0">
              <li>
                <FacetRow
                  checked={filters.interaction === "true"}
                  onToggle={() =>
                    onChange({
                      ...filters,
                      interaction: filters.interaction === "true" ? null : "true",
                    })
                  }
                  dotClass="bg-amber-500"
                  label="With interaction"
                  count={meta?.interactionCounts.withInteraction}
                />
              </li>
              <li>
                <FacetRow
                  checked={filters.interaction === "false"}
                  onToggle={() =>
                    onChange({
                      ...filters,
                      interaction: filters.interaction === "false" ? null : "false",
                    })
                  }
                  dotClass="bg-muted-foreground/40"
                  label="Without interaction"
                  count={meta?.interactionCounts.withoutInteraction}
                />
              </li>
            </ul>
          </FacetSection>

          {/* Time range facet */}
          <FacetSection value="time-range" label="Time range">
            <ul className="space-y-0">
              {TIME_RANGE_PRESETS.map((preset) => {
                const active = currentPresetKey === preset.key;
                return (
                  <li key={preset.key}>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        const range = resolveTimeRange(preset.key);
                        onChange({ ...filters, from: range.from, to: range.to });
                      }}
                      className={cn(
                        "h-auto w-full justify-start flex items-center gap-2.5 py-1 text-left text-xs",
                        "text-muted-foreground hover:text-foreground hover:bg-transparent",
                        active && "text-foreground",
                      )}
                    >
                      <span
                        className={cn(
                          "inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border border-border",
                          active && "border-foreground",
                        )}
                        aria-hidden
                      >
                        {active ? <span className="size-1.5 rounded-full bg-foreground" /> : null}
                      </span>
                      <span className="flex-1">{preset.label}</span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          </FacetSection>
        </Accordion>
      </div>
    </div>
  );
}
