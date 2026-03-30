import type {
  LocalScopePolicy,
} from "@executor/platform-sdk/schema";

import { cn } from "../lib/cn";

export type ToolPermissionLevel = "auto-run" | "requires-approval" | "denied";

const matchesGlob = (pattern: string, value: string): boolean => {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
};

const policySpecificity = (policy: LocalScopePolicy): number =>
  policy.priority + Math.max(1, policy.resourcePattern.replace(/\*/g, "").length);

export const resolveToolPermission = (
  toolPath: string,
  policies: ReadonlyArray<LocalScopePolicy>,
  toolInteraction?: "auto" | "required",
): {
  level: ToolPermissionLevel;
  matchedPolicy: LocalScopePolicy | null;
} => {
  const matching = policies
    .filter(
      (policy) =>
        policy.enabled && matchesGlob(policy.resourcePattern, toolPath),
    )
    .sort(
      (left, right) =>
        policySpecificity(right) - policySpecificity(left) ||
        left.updatedAt - right.updatedAt,
    );

  const matched = matching[0];
  if (!matched) {
    // No explicit policy — resolve from the tool's intrinsic interaction mode
    const defaultLevel: ToolPermissionLevel =
      toolInteraction === "auto" ? "auto-run" : "requires-approval";
    return { level: defaultLevel, matchedPolicy: null };
  }

  if (matched.effect === "deny") {
    return { level: "denied", matchedPolicy: matched };
  }

  if (matched.approvalMode === "required") {
    return { level: "requires-approval", matchedPolicy: matched };
  }

  return { level: "auto-run", matchedPolicy: matched };
};

const permissionStyles: Record<
  ToolPermissionLevel,
  { label: string; dotClass: string; textClass: string }
> = {
  "auto-run": {
    label: "Auto",
    dotClass: "bg-emerald-500",
    textClass: "text-emerald-600 dark:text-emerald-400",
  },
  "requires-approval": {
    label: "Approval",
    dotClass: "bg-amber-500",
    textClass: "text-amber-600 dark:text-amber-400",
  },
  denied: {
    label: "Denied",
    dotClass: "bg-red-500",
    textClass: "text-red-600 dark:text-red-400",
  },
};

export const ToolPermissionDot = (props: {
  toolPath: string;
  policies: ReadonlyArray<LocalScopePolicy>;
  interaction?: "auto" | "required";
  className?: string;
}) => {
  const { level } = resolveToolPermission(props.toolPath, props.policies, props.interaction);
  const style = permissionStyles[level];

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[9px] font-medium leading-none",
        style.textClass,
        props.className,
      )}
      title={style.label}
    >
      <span className={cn("size-1.5 rounded-full", style.dotClass)} />
      {style.label}
    </span>
  );
};

export const ToolPermissionBadge = (props: {
  toolPath: string;
  policies: ReadonlyArray<LocalScopePolicy>;
  interaction?: "auto" | "required";
  className?: string;
}) => {
  const { level, matchedPolicy } = resolveToolPermission(
    props.toolPath,
    props.policies,
    props.interaction,
  );
  const style = permissionStyles[level];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
        level === "auto-run" &&
          "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        level === "requires-approval" &&
          "border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400",
        level === "denied" &&
          "border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400",
        props.className,
      )}
      title={
        matchedPolicy
          ? `Matched policy: ${matchedPolicy.resourcePattern}`
          : undefined
      }
    >
      <span className={cn("size-1 rounded-full", style.dotClass)} />
      {style.label}
    </span>
  );
};
