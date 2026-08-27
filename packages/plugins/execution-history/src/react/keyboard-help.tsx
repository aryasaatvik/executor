import { Keyboard } from "lucide-react";
import { Button } from "@executor-js/react/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@executor-js/react/components/dropdown-menu";

const SHORTCUTS: readonly { readonly label: string; readonly keys: readonly string[] }[] = [
  { label: "Focus filter", keys: ["/"] },
  { label: "Toggle live", keys: ["j"] },
  { label: "Refresh", keys: ["r"] },
  { label: "Keyboard shortcuts", keys: ["?"] },
];

const NAV_SHORTCUTS: readonly { readonly label: string; readonly keys: readonly string[] }[] = [
  { label: "Toggle filter rail", keys: ["b"] },
  { label: "Navigate rows", keys: ["↑", "↓"] },
  { label: "Close drawer", keys: ["Esc"] },
];

export function KeyboardHelp(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <DropdownMenu open={props.open} onOpenChange={props.onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Keyboard shortcuts">
          <Keyboard className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>Keyboard shortcuts</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {SHORTCUTS.map((shortcut) => (
          <DropdownMenuItem key={shortcut.label} disabled>
            {shortcut.label}
            <DropdownMenuShortcut>{shortcut.keys.join(" ")}</DropdownMenuShortcut>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {NAV_SHORTCUTS.map((shortcut) => (
          <DropdownMenuItem key={shortcut.label} disabled>
            {shortcut.label}
            <DropdownMenuShortcut>{shortcut.keys.join(" ")}</DropdownMenuShortcut>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
