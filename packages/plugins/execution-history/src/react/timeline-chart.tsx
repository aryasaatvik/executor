import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ReferenceArea, XAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@executor-js/react/components/chart";
import type { ChartConfig } from "@executor-js/react/components/chart";
import { cn } from "@executor-js/react/lib/utils";

import type { RunStatus } from "../sdk/collections";
import type { RunChartBucket } from "../sdk/store";
import { STATUS_CHART_HEX, STATUS_LABELS, STATUS_ORDER } from "./status";

// ---------------------------------------------------------------------------
// Compact stacked-bar timeline of runs over time, one series per RunStatus.
//
// The store's chart buckets nest per-status counts under `.counts`; recharts
// needs a flat row, so each bucket is flattened into
// `{ bucketStart, <status>: count, ... }` keyed by status. Drag across the
// chart to select a time range (recharts hands us the `bucketStart` under the
// cursor via `activeLabel`); releasing emits `onRangeSelect`.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

const TIMELINE_CONFIG: ChartConfig = Object.fromEntries(
  STATUS_ORDER.map((status) => [
    status,
    { label: STATUS_LABELS[status], color: STATUS_CHART_HEX[status] },
  ]),
);

type ChartRow = { readonly bucketStart: number } & Record<RunStatus, number>;

/** Flatten `bucket.counts` onto the row so recharts can stack per-status. */
const toChartRow = (bucket: RunChartBucket): ChartRow => {
  const row = { bucketStart: bucket.bucketStart } as { bucketStart: number } & Record<
    RunStatus,
    number
  >;
  for (const status of STATUS_ORDER) {
    row[status] = bucket.counts[status] ?? 0;
  }
  return row;
};

const buildAxisFormatter =
  (bucketMs: number) =>
  (value: number): string => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    const options: Intl.DateTimeFormatOptions =
      bucketMs <= 60_000
        ? { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
        : bucketMs < DAY_MS
          ? { hour: "2-digit", minute: "2-digit", hour12: false }
          : bucketMs >= 7 * DAY_MS
            ? { month: "short", day: "numeric" }
            : { month: "2-digit", day: "2-digit" };
    return new Intl.DateTimeFormat(undefined, options).format(date);
  };

const formatTooltipLabel = (value: number, bucketMs: number): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(bucketMs <= 60_000 ? { second: "2-digit" as const } : {}),
    hour12: false,
  }).format(date);
};

// recharts surfaces the category under the cursor on its mouse events; only
// `activeLabel` is relevant here (the `bucketStart` of the hovered bar).
type ChartMouseEvent = { readonly activeLabel?: string | number };

const labelToBucket = (value: string | number | null): number | null => {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function RunsTimelineChart(props: {
  readonly data: readonly RunChartBucket[];
  readonly bucketMs: number;
  readonly onRangeSelect?: (range: { readonly from: number; readonly to: number }) => void;
  readonly className?: string;
}) {
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragEnd, setDragEnd] = useState<number | null>(null);

  const rows = useMemo(() => props.data.map(toChartRow), [props.data]);
  const formatAxisTick = useMemo(() => buildAxisFormatter(props.bucketMs), [props.bucketMs]);

  const resetDrag = () => {
    setDragStart(null);
    setDragEnd(null);
  };

  const handleMouseDown = (event: ChartMouseEvent | null | undefined) => {
    const bucket = labelToBucket(event?.activeLabel ?? null);
    if (bucket == null) return;
    setDragStart(bucket);
    setDragEnd(bucket);
  };

  const handleMouseMove = (event: ChartMouseEvent | null | undefined) => {
    if (dragStart == null) return;
    const bucket = labelToBucket(event?.activeLabel ?? null);
    if (bucket != null) setDragEnd(bucket);
  };

  const handleMouseUp = () => {
    if (dragStart != null && dragEnd != null && dragStart !== dragEnd && props.onRangeSelect) {
      const from = Math.min(dragStart, dragEnd);
      const to = Math.max(dragStart, dragEnd) + props.bucketMs;
      props.onRangeSelect({ from, to });
    }
    resetDrag();
  };

  if (rows.length === 0) {
    return (
      <div
        className={cn(
          "flex h-24 items-center justify-center font-mono text-[10px] tracking-wider text-muted-foreground/50 uppercase",
          props.className,
        )}
      >
        No activity
      </div>
    );
  }

  return (
    <ChartContainer
      config={TIMELINE_CONFIG}
      className={cn(
        "aspect-auto h-28 w-full select-none",
        "[&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted/40",
        props.className,
      )}
    >
      <BarChart
        accessibilityLayer
        data={rows}
        margin={{ top: 4, left: 0, right: 0, bottom: 0 }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: "crosshair" }}
      >
        <CartesianGrid vertical={false} strokeDasharray="3 3" strokeOpacity={0.25} />
        <XAxis
          dataKey="bucketStart"
          scale="band"
          tickLine={false}
          axisLine={false}
          minTickGap={32}
          tickFormatter={formatAxisTick}
        />
        <ChartTooltip
          cursor={false}
          allowEscapeViewBox={{ x: false, y: true }}
          wrapperStyle={{ zIndex: 50, pointerEvents: "none" }}
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => {
                const first = payload?.[0]?.payload as { bucketStart?: number } | undefined;
                return first?.bucketStart == null
                  ? "—"
                  : formatTooltipLabel(first.bucketStart, props.bucketMs);
              }}
            />
          }
        />
        {STATUS_ORDER.map((status) => (
          <Bar
            key={status}
            dataKey={status}
            name={STATUS_LABELS[status]}
            stackId="runs"
            fill={STATUS_CHART_HEX[status]}
            isAnimationActive={false}
            // Cap the width so a handful of buckets render as slim columns
            // rather than band-filling slabs; wide bands center the bar.
            maxBarSize={28}
          />
        ))}
        {dragStart != null && dragEnd != null && dragStart !== dragEnd ? (
          <ReferenceArea
            x1={Math.min(dragStart, dragEnd)}
            x2={Math.max(dragStart, dragEnd)}
            strokeOpacity={0.3}
            fill="var(--foreground)"
            fillOpacity={0.08}
          />
        ) : null}
      </BarChart>
    </ChartContainer>
  );
}
