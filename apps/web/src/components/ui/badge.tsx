import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary/15 text-primary",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-muted-foreground",
        muted: "border-transparent bg-muted text-muted-foreground",
        get: "border-[var(--method-get)]/20 bg-[var(--method-get)]/10 text-[var(--method-get)]",
        post: "border-[var(--method-post)]/20 bg-[var(--method-post)]/10 text-[var(--method-post)]",
        put: "border-[var(--method-put)]/20 bg-[var(--method-put)]/10 text-[var(--method-put)]",
        delete: "border-[var(--method-delete)]/20 bg-[var(--method-delete)]/10 text-[var(--method-delete)]",
        destructive: "border-destructive/20 bg-destructive/10 text-destructive",
        "status-completed": "border-emerald-500/20 bg-emerald-500/10 text-emerald-500",
        "status-failed": "border-destructive/20 bg-destructive/10 text-destructive",
        "status-running": "border-blue-500/20 bg-blue-500/10 text-blue-500",
        "status-waiting": "border-amber-500/20 bg-amber-500/10 text-amber-500",
        "status-pending": "border-blue-500/20 bg-blue-500/10 text-blue-500",
        "status-cancelled": "border-transparent bg-muted text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export function ExecutionStatusBadge({ status }: { status: string }) {
  const variantMap: Record<string, string> = {
    completed: "status-completed",
    failed: "status-failed",
    running: "status-running",
    pending: "status-pending",
    waiting_for_interaction: "status-waiting",
    cancelled: "status-cancelled",
  };
  const variant = (variantMap[status] ?? "muted") as any;
  const label = status === "waiting_for_interaction" ? "waiting" : status;
  return <Badge variant={variant}>{label}</Badge>;
}

export function MethodBadge({ method }: { method: string }) {
  const variant = ({
    GET: "get",
    POST: "post",
    PUT: "put",
    PATCH: "put",
    DELETE: "delete",
  } as const)[method.toUpperCase()] ?? "outline";

  return <Badge variant={variant}>{method}</Badge>;
}
