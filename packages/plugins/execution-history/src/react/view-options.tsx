import { Check, Settings2 } from "lucide-react";
import { Button } from "@executor-js/react/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@executor-js/react/components/popover";
import { cn } from "@executor-js/react/lib/utils";

import { RUN_COLUMN_LABELS, type RunColumnKey, type RunColumns } from "./view";

const COLUMN_KEYS: readonly RunColumnKey[] = [
  "trigger",
  "actor",
  "duration",
  "tools",
  "interaction",
  "log",
];

export function ViewOptions(props: {
  readonly columns: RunColumns;
  readonly onToggle: (key: RunColumnKey) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="View options">
          <Settings2 className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44 p-1">
        <p className="px-2 py-1.5 text-[10px] font-medium uppercase text-muted-foreground">
          Columns
        </p>
        {COLUMN_KEYS.map((key) => (
          <Button
            key={key}
            type="button"
            variant="ghost"
            onClick={() => props.onToggle(key)}
            className={cn(
              "h-auto w-full justify-start flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors",
              "hover:bg-accent hover:text-accent-foreground",
            )}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              {props.columns[key] && <Check className="size-3.5" />}
            </span>
            {RUN_COLUMN_LABELS[key]}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
