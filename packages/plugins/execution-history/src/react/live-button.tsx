import { CirclePause, CirclePlay } from "lucide-react";
import { Button } from "@executor-js/react/components/button";
import { cn } from "@executor-js/react/lib/utils";

export function LiveButton(props: { readonly active: boolean; readonly onToggle: () => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-pressed={props.active}
      onClick={props.onToggle}
      className={cn(
        "gap-1.5",
        props.active &&
          "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300",
      )}
    >
      {props.active ? (
        <>
          <span className="relative flex size-2 shrink-0">
            <span className="absolute inline-flex size-full animate-pulse rounded-full bg-emerald-500 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
          <CirclePause className="size-3.5" />
          Live
        </>
      ) : (
        <>
          <CirclePlay className="size-3.5" />
          Live
        </>
      )}
    </Button>
  );
}
