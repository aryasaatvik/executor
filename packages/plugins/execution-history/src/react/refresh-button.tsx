import { LoaderCircle, RefreshCcw } from "lucide-react";
import { Button } from "@executor-js/react/components/button";

export function RefreshButton(props: {
  readonly onClick: () => void;
  readonly isLoading?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Refresh"
      onClick={props.onClick}
      disabled={props.isLoading}
    >
      {props.isLoading ? (
        <LoaderCircle className="size-3.5 animate-spin" />
      ) : (
        <RefreshCcw className="size-3.5" />
      )}
    </Button>
  );
}
