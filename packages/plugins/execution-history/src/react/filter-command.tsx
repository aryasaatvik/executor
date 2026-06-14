import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@executor-js/react/components/command";
import { cn } from "@executor-js/react/lib/utils";

import type { RunStatus } from "../sdk/collections";
import type { ExecutionListMeta } from "../sdk/store";
import { FILTER_KEYS, parseRunsFilter, type RunsFilterTokens } from "./filter-command-parser";
import type { RunsFilters } from "./use-runs-list";
import { STATUS_LABELS, STATUS_ORDER, statusTone, triggerTone } from "./status";

// ---------------------------------------------------------------------------
// Runs filter command palette. A controlled cmdk input that surfaces live facet
// suggestions (status + trigger counts from `meta`) while typing a token, plus
// an "Add filter" group of key hints. Selecting a suggestion toggles that facet
// immediately; pressing Enter parses the whole input as `key:value` tokens and
// merges them onto the current filters.
//
// Contract adaptations vs the inline prototype: only the 4 statuses, no tool or
// code facets, and `meta.statusCounts`/`triggerCounts` are arrays (iterated,
// never `Object.entries`). `status:` accepts either the canonical status value
// or its display label (e.g. `waiting` -> `waiting_for_interaction`).
// ---------------------------------------------------------------------------

export interface RunsFilterCommandProps {
  readonly filters: RunsFilters;
  readonly meta: ExecutionListMeta | null;
  readonly onApply: (filters: RunsFilters) => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** Map a typed status token (canonical value or display label) back to the
 *  canonical RunStatus, or null when it matches neither. */
const canonicalStatus = (token: string): RunStatus | null => {
  for (const status of STATUS_ORDER) {
    if (status === token || STATUS_LABELS[status] === token) return status;
  }
  return null;
};

/** Toggle one value within a readonly facet list (add when absent, drop when
 *  present), returning a new array. */
const toggleFacet = (current: readonly string[], value: string): string[] =>
  current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value];

/** Merge parsed tokens onto the current filters: status/trigger REPLACE (only
 *  when present and valid), interaction/from/to are set only when the token was
 *  actually typed — so applying a command never wipes a time range or
 *  interaction filter set elsewhere (the rail, the timeline drag). The palette
 *  sets filters; clearing is done from the rail. Status tokens are normalized to
 *  canonical RunStatus values; an all-invalid status token leaves status
 *  untouched. */
const mergeTokens = (filters: RunsFilters, tokens: RunsFilterTokens): RunsFilters => {
  const statuses = tokens.status
    .map(canonicalStatus)
    .filter((status): status is RunStatus => status !== null);
  return {
    ...filters,
    status: statuses.length > 0 ? statuses : filters.status,
    trigger: tokens.trigger.length > 0 ? tokens.trigger : filters.trigger,
    interaction: tokens.interaction !== null ? tokens.interaction : filters.interaction,
    from: tokens.from !== null ? tokens.from : filters.from,
    to: tokens.to !== null ? tokens.to : filters.to,
  };
};

interface FacetSuggestion {
  readonly value: string;
  readonly label: string;
  readonly hint: string;
}

export const RunsFilterCommand = forwardRef<HTMLInputElement, RunsFilterCommandProps>(
  function RunsFilterCommand({ filters, meta, onApply, open, onOpenChange }, forwardedRef) {
    const [value, setValue] = useState("");
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(forwardedRef, () => inputRef.current as HTMLInputElement, []);

    // Close on an outside pointer press while open.
    useEffect(() => {
      if (!open) return;
      const handlePointer = (event: PointerEvent) => {
        const target = event.target as Node | null;
        if (!containerRef.current || !target) return;
        if (!containerRef.current.contains(target)) onOpenChange(false);
      };
      window.addEventListener("pointerdown", handlePointer);
      return () => window.removeEventListener("pointerdown", handlePointer);
    }, [open, onOpenChange]);

    const statusCounts = useMemo(() => {
      const counts = new Map<string, number>();
      for (const entry of meta?.statusCounts ?? []) counts.set(entry.status, entry.count);
      return counts;
    }, [meta]);

    const triggerSuggestions = useMemo<readonly FacetSuggestion[]>(() => {
      const entries = meta?.triggerCounts ?? [];
      return entries
        .filter(
          (entry): entry is { triggerKind: string; count: number } => entry.triggerKind !== null,
        )
        .map((entry) => ({
          value: entry.triggerKind,
          label: triggerTone(entry.triggerKind).label,
          hint: `${entry.count}`,
        }));
    }, [meta]);

    const statusSuggestions = useMemo<readonly FacetSuggestion[]>(
      () =>
        STATUS_ORDER.map((status) => ({
          value: status,
          label: STATUS_LABELS[status],
          hint: `${statusCounts.get(status) ?? 0}`,
        })),
      [statusCounts],
    );

    const applyFilters = (next: RunsFilters) => {
      onApply(next);
    };

    const applyTokens = () => {
      const merged = mergeTokens(filters, parseRunsFilter(value));
      applyFilters(merged);
      setValue("");
      onOpenChange(false);
      inputRef.current?.blur();
    };

    const toggleStatus = (status: string) => {
      applyFilters({ ...filters, status: toggleFacet(filters.status, status) });
    };

    const toggleTrigger = (trigger: string) => {
      applyFilters({ ...filters, trigger: toggleFacet(filters.trigger, trigger) });
    };

    const insertKey = (key: string) => {
      const trimmed = value.trimEnd();
      setValue(trimmed.length === 0 ? `${key}:` : `${trimmed} ${key}:`);
      inputRef.current?.focus();
    };

    if (!open) {
      return (
        <div ref={containerRef} className="relative w-full">
          <Command shouldFilter={false} className="overflow-visible bg-transparent">
            <CommandInput
              ref={inputRef}
              value={value}
              onValueChange={setValue}
              onFocus={() => onOpenChange(true)}
              placeholder="Filter runs — status:… trigger:… interaction:… after:…"
              className="font-mono text-xs"
            />
          </Command>
        </div>
      );
    }

    return (
      <div ref={containerRef} className="relative w-full">
        <Command
          shouldFilter={false}
          className="overflow-visible bg-transparent"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              applyTokens();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onOpenChange(false);
              inputRef.current?.blur();
            }
          }}
        >
          <CommandInput
            ref={inputRef}
            value={value}
            onValueChange={setValue}
            onFocus={() => onOpenChange(true)}
            placeholder="Filter runs — status:… trigger:… interaction:… after:…"
            className="font-mono text-xs"
          />

          <div
            className={cn(
              "absolute top-full right-0 left-0 z-20 mt-1",
              "overflow-hidden rounded-md border border-border",
              "bg-popover text-popover-foreground shadow-md",
            )}
          >
            <CommandList className="max-h-[420px]">
              <CommandEmpty>
                <span className="font-mono text-[11px] text-muted-foreground">
                  No matching filters.
                </span>
              </CommandEmpty>

              <CommandGroup heading="Status">
                {statusSuggestions.map((suggestion) => {
                  const active = filters.status.includes(suggestion.value);
                  const tone = statusTone(suggestion.value as RunStatus);
                  return (
                    <CommandItem
                      key={`status-${suggestion.value}`}
                      value={`status-${suggestion.value}`}
                      onSelect={() => toggleStatus(suggestion.value)}
                    >
                      <span className={cn("size-1.5 rounded-full", tone.dot)} aria-hidden />
                      <span className={cn("font-mono text-xs", active && "font-semibold")}>
                        {suggestion.label}
                      </span>
                      {active ? (
                        <span className="ml-1 text-[10px] text-muted-foreground">✓</span>
                      ) : null}
                      <CommandShortcut>{suggestion.hint}</CommandShortcut>
                    </CommandItem>
                  );
                })}
              </CommandGroup>

              {triggerSuggestions.length > 0 ? (
                <CommandGroup heading="Trigger">
                  {triggerSuggestions.map((suggestion) => {
                    const active = filters.trigger.includes(suggestion.value);
                    const tone = triggerTone(suggestion.value);
                    return (
                      <CommandItem
                        key={`trigger-${suggestion.value}`}
                        value={`trigger-${suggestion.value}`}
                        onSelect={() => toggleTrigger(suggestion.value)}
                      >
                        <span className={cn("size-1.5 rounded-full", tone.dot)} aria-hidden />
                        <span className={cn("font-mono text-xs", active && "font-semibold")}>
                          {suggestion.label}
                        </span>
                        {active ? (
                          <span className="ml-1 text-[10px] text-muted-foreground">✓</span>
                        ) : null}
                        <CommandShortcut>{suggestion.hint}</CommandShortcut>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ) : null}

              <CommandSeparator />

              <CommandGroup heading="Add filter">
                {FILTER_KEYS.map((entry) => (
                  <CommandItem
                    key={`key-${entry.key}`}
                    value={`key-${entry.key}`}
                    onSelect={() => insertKey(entry.key)}
                  >
                    <span className="font-mono text-xs text-foreground">{entry.key}:</span>
                    <span className="text-[11px] text-muted-foreground">{entry.hint}</span>
                  </CommandItem>
                ))}
              </CommandGroup>

              <CommandSeparator />

              <CommandGroup heading="Apply">
                <CommandItem value="apply-filters" onSelect={applyTokens}>
                  <span className="text-xs font-medium text-foreground">Apply filters</span>
                  <CommandShortcut>Enter</CommandShortcut>
                </CommandItem>
              </CommandGroup>
            </CommandList>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 bg-muted/20 px-3 py-2 font-mono text-[10px] text-muted-foreground/70">
              <span className="flex items-center gap-1">
                <span>Use</span>
                <kbd className="rounded-sm border border-border bg-muted/50 px-1 font-sans">↑↓</kbd>
                <span>to navigate</span>
              </span>
              <span className="text-muted-foreground/30">·</span>
              <span className="flex items-center gap-1">
                <kbd className="rounded-sm border border-border bg-muted/50 px-1 font-sans">
                  Enter
                </kbd>
                <span>to apply</span>
              </span>
              <span className="text-muted-foreground/30">·</span>
              <span className="flex items-center gap-1">
                <kbd className="rounded-sm border border-border bg-muted/50 px-1 font-sans">
                  Esc
                </kbd>
                <span>to close</span>
              </span>
              <span className="text-muted-foreground/30">·</span>
              <span>
                Union:{" "}
                <code className="rounded-sm bg-muted/50 px-1 text-muted-foreground">
                  status:failed,completed
                </code>
              </span>
              <span className="text-muted-foreground/30">·</span>
              <span>
                Time:{" "}
                <code className="rounded-sm bg-muted/50 px-1 text-muted-foreground">after:1h</code>
              </span>
            </div>
          </div>
        </Command>
      </div>
    );
  },
);
