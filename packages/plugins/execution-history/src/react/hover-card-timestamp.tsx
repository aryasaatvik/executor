import { useCallback, useState } from "react";
import { Check, Copy } from "lucide-react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@executor-js/react/components/hover-card";
import { cn } from "@executor-js/react/lib/utils";

import { formatRelative } from "./format";

// ---------------------------------------------------------------------------
// Hover popup over a timestamp: the trigger shows whatever `display` is given
// (the list row passes a relative "1 hour ago"; the drawer falls back to the
// absolute format), and hovering reveals the epoch ms, UTC, local-tz, and
// relative renderings — each a click-to-copy row. Native Date/Intl only (the
// plugin deliberately carries no date-fns dep); reuses the shared Radix
// HoverCard from @executor-js/react.
// ---------------------------------------------------------------------------

const absolute = (timestamp: number, timeZone?: string): string =>
  new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).format(timestamp);

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

export interface HoverCardTimestampProps {
  readonly timestamp: number;
  /** Trigger text; defaults to the absolute local format. */
  readonly display?: React.ReactNode;
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly align?: "start" | "center" | "end";
  readonly className?: string;
}

export function HoverCardTimestamp({
  timestamp,
  display,
  side = "right",
  align = "start",
  className,
}: HoverCardTimestampProps) {
  return (
    <HoverCard openDelay={0} closeDelay={150}>
      <HoverCardTrigger asChild>
        <span className={cn("font-mono whitespace-nowrap", className)}>
          {display ?? absolute(timestamp)}
        </span>
      </HoverCardTrigger>
      <HoverCardContent side={side} align={align} alignOffset={-4} className="z-50 w-auto p-2">
        <dl className="flex flex-col gap-1">
          <CopyRow label="Timestamp" value={String(timestamp)} />
          <CopyRow label="UTC" value={absolute(timestamp, "UTC")} />
          <CopyRow label={LOCAL_TZ} value={absolute(timestamp)} />
          <CopyRow label="Relative" value={formatRelative(timestamp)} />
        </dl>
      </HoverCardContent>
    </HoverCard>
  );
}

function CopyRow({ label, value }: { readonly label: string; readonly value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(
    (event: React.MouseEvent | React.KeyboardEvent) => {
      event.stopPropagation();
      void navigator.clipboard.writeText(value).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      });
    },
    [value],
  );
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={copy}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          copy(event);
        }
      }}
      className="group flex items-center justify-between gap-4 text-xs"
    >
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-1 truncate font-mono">
        <span className="invisible group-hover:visible">
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </span>
        {value}
      </dd>
    </div>
  );
}
