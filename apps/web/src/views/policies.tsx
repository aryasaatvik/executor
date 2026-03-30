import { useState, type ReactNode } from "react";
import {
  type LocalScopePolicy,
  type LocalScopePolicyApprovalMode,
  type LocalScopePolicyEffect,
  useCreatePolicy,
  usePolicies,
  useRemovePolicy,
  useUpdatePolicy,
} from "@executor/react";

import { LoadableBlock } from "../components/loadable";
import {
  Alert,
  Badge,
  Button,
  Card,
  Input,
  Label,
  Select,
} from "@executor/react/plugins";
import {
  IconPencil,
  IconPlus,
  IconSpinner,
  IconTrash,
} from "../components/icons";
import { cn } from "../lib/utils";

// ── Permission state helpers ────────────────────────────────────────────

type PermissionLevel = "auto-run" | "requires-approval" | "denied";

const resolvePermissionLevel = (
  effect: LocalScopePolicyEffect,
  approvalMode: LocalScopePolicyApprovalMode,
): PermissionLevel => {
  if (effect === "deny") return "denied";
  if (approvalMode === "required") return "requires-approval";
  return "auto-run";
};

const permissionConfig: Record<
  PermissionLevel,
  { label: string; className: string; dotClassName: string }
> = {
  "auto-run": {
    label: "Auto-run",
    className:
      "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    dotClassName: "bg-emerald-500",
  },
  "requires-approval": {
    label: "Approval",
    className:
      "border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    dotClassName: "bg-amber-500",
  },
  denied: {
    label: "Denied",
    className:
      "border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400",
    dotClassName: "bg-red-500",
  },
};

const PermissionBadge = (props: {
  effect: LocalScopePolicyEffect;
  approvalMode: LocalScopePolicyApprovalMode;
}) => {
  const level = resolvePermissionLevel(props.effect, props.approvalMode);
  const config = permissionConfig[level];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        config.className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", config.dotClassName)} />
      {config.label}
    </span>
  );
};

// ── Page ────────────────────────────────────────────────────────────────

export function PoliciesPage() {
  const policies = usePolicies();
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-10 lg:px-10 lg:py-14">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl tracking-tight text-foreground lg:text-4xl">
              Policies
            </h1>
            <p className="mt-1.5 text-[14px] text-muted-foreground">
              Control which tools can auto-run, require approval, or are
              completely denied.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setShowCreate(true);
              setEditingId(null);
            }}
          >
            <IconPlus className="size-3.5" />
            Add policy
          </Button>
        </div>

        {showCreate && (
          <CreatePolicyForm
            className="mb-2"
            onClose={() => setShowCreate(false)}
          />
        )}

        <section className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              Active Policies
            </h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Policies are matched by resource pattern using glob syntax.
              Higher priority rules take precedence.
            </p>
          </div>

          <LoadableBlock loadable={policies} loading="Loading policies...">
            {(items) =>
              items.length === 0 && !showCreate ? (
                <SectionEmptyState
                  title="No policies configured"
                  description="Add a policy to control tool permissions. By default all tools require approval."
                  actionLabel="Add policy"
                  onAction={() => {
                    setShowCreate(true);
                    setEditingId(null);
                  }}
                />
              ) : (
                <Card className="overflow-hidden p-0">
                  {[...items]
                    .sort((a, b) => b.priority - a.priority)
                    .map((policy, index) => (
                      <div
                        key={policy.id}
                        className={cn(
                          "px-5 py-3.5",
                          index > 0 && "border-t border-border",
                          !policy.enabled && "opacity-50",
                        )}
                      >
                        <PolicyRow
                          policy={policy}
                          isEditing={editingId === policy.id}
                          onEdit={() =>
                            setEditingId(
                              editingId === policy.id ? null : policy.id,
                            )
                          }
                          onCancelEdit={() => setEditingId(null)}
                        />
                      </div>
                    ))}
                </Card>
              )
            }
          </LoadableBlock>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">
            How policies work
          </h2>
          <div className="grid gap-3 md:grid-cols-3">
            <HelpCard level="auto-run">
              <strong>Auto-run</strong> tools execute immediately without
              asking. Use for trusted, read-only operations.
            </HelpCard>
            <HelpCard level="requires-approval">
              <strong>Approval</strong> tools pause and ask before running.
              The default for most tools.
            </HelpCard>
            <HelpCard level="denied">
              <strong>Denied</strong> tools are blocked completely and cannot
              be invoked.
            </HelpCard>
          </div>
          <p className="text-[12px] text-muted-foreground/60">
            Patterns use glob syntax: <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">*</code> matches
            all tools, <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">github.*</code> matches all
            GitHub tools, <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">*.delete</code> matches
            all delete operations.
          </p>
        </section>
      </div>
    </div>
  );
}

// ── Create form ─────────────────────────────────────────────────────────

function CreatePolicyForm(props: { className?: string; onClose: () => void }) {
  const createPolicy = useCreatePolicy();
  const [pattern, setPattern] = useState("*");
  const [effect, setEffect] = useState<LocalScopePolicyEffect>("allow");
  const [approvalMode, setApprovalMode] =
    useState<LocalScopePolicyApprovalMode>("auto");
  const [priority, setPriority] = useState("0");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);

    const trimmedPattern = pattern.trim();
    if (!trimmedPattern) {
      setError("Resource pattern is required.");
      return;
    }

    try {
      await createPolicy.mutateAsync({
        resourcePattern: trimmedPattern,
        effect,
        approvalMode,
        priority: Number(priority) || 0,
        enabled: true,
      });
      props.onClose();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed creating policy.",
      );
    }
  };

  return (
    <FormCard
      className={props.className}
      title="New policy"
      onClose={props.onClose}
    >
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2 sm:col-span-2">
          <Label>Resource pattern</Label>
          <Input
            value={pattern}
            onChange={(event) => setPattern(event.target.value)}
            placeholder="github.* or *.delete"
            className="font-mono text-[12px]"
            autoFocus
          />
          <p className="text-[11px] text-muted-foreground/60">
            Glob pattern matched against tool paths.
          </p>
        </div>
        <div className="grid gap-2">
          <Label>Permission</Label>
          <Select
            value={`${effect}:${approvalMode}`}
            onChange={(event) => {
              const [newEffect, newApproval] = event.target.value.split(":") as [
                LocalScopePolicyEffect,
                LocalScopePolicyApprovalMode,
              ];
              setEffect(newEffect);
              setApprovalMode(newApproval);
            }}
          >
            <option value="allow:auto">Auto-run</option>
            <option value="allow:required">Requires approval</option>
            <option value="deny:auto">Denied</option>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label>Priority</Label>
          <Input
            type="number"
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
            placeholder="0"
          />
          <p className="text-[11px] text-muted-foreground/60">
            Higher priority rules win when multiple patterns match.
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <PermissionBadge effect={effect} approvalMode={approvalMode} />
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={createPolicy.status === "pending"}
        >
          {createPolicy.status === "pending" ? (
            <IconSpinner className="size-3.5" />
          ) : (
            <IconPlus className="size-3.5" />
          )}
          Create policy
        </Button>
      </div>
    </FormCard>
  );
}

// ── Policy row ──────────────────────────────────────────────────────────

function PolicyRow(props: {
  policy: LocalScopePolicy;
  isEditing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
}) {
  const removePolicy = useRemovePolicy();
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await removePolicy.mutateAsync(props.policy.id);
    } catch {
      // refresh state will keep the policy visible
    } finally {
      setIsDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-mono text-[13px] font-medium text-foreground">
              {props.policy.resourcePattern}
            </span>
            <PermissionBadge
              effect={props.policy.effect}
              approvalMode={props.policy.approvalMode}
            />
            {!props.policy.enabled && (
              <Badge variant="outline" className="text-[9px] uppercase">
                disabled
              </Badge>
            )}
            {props.policy.priority !== 0 && (
              <Badge variant="outline" className="text-[9px]">
                priority {props.policy.priority}
              </Badge>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground/50">
            <span className="font-mono">{props.policy.id}</span>
            <span>{formatDate(props.policy.createdAt)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={props.onEdit}
            className={cn(
              props.isEditing
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <IconPencil className="size-3" />
            Edit
          </Button>
          {confirmDelete ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDelete(false)}
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive-outline"
                size="sm"
                onClick={() => {
                  void handleDelete();
                }}
                disabled={isDeleting}
              >
                {isDeleting ? (
                  <IconSpinner className="size-3" />
                ) : (
                  <IconTrash className="size-3" />
                )}
                Delete
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDelete(true)}
              disabled={isDeleting}
              className="text-muted-foreground hover:bg-destructive/8 hover:text-destructive"
            >
              {isDeleting ? (
                <IconSpinner className="size-3" />
              ) : (
                <IconTrash className="size-3" />
              )}
              Delete
            </Button>
          )}
        </div>
      </div>

      {props.isEditing && (
        <EditPolicyForm policy={props.policy} onClose={props.onCancelEdit} />
      )}
    </>
  );
}

// ── Edit form ───────────────────────────────────────────────────────────

function EditPolicyForm(props: {
  policy: LocalScopePolicy;
  onClose: () => void;
}) {
  const updatePolicy = useUpdatePolicy();
  const [pattern, setPattern] = useState(props.policy.resourcePattern);
  const [effect, setEffect] = useState<LocalScopePolicyEffect>(
    props.policy.effect,
  );
  const [approvalMode, setApprovalMode] =
    useState<LocalScopePolicyApprovalMode>(props.policy.approvalMode);
  const [priority, setPriority] = useState(String(props.policy.priority));
  const [enabled, setEnabled] = useState(props.policy.enabled);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);

    const payload: Record<string, unknown> = {};
    const trimmedPattern = pattern.trim();

    if (trimmedPattern && trimmedPattern !== props.policy.resourcePattern) {
      payload.resourcePattern = trimmedPattern;
    }
    if (effect !== props.policy.effect) {
      payload.effect = effect;
    }
    if (approvalMode !== props.policy.approvalMode) {
      payload.approvalMode = approvalMode;
    }
    const numPriority = Number(priority) || 0;
    if (numPriority !== props.policy.priority) {
      payload.priority = numPriority;
    }
    if (enabled !== props.policy.enabled) {
      payload.enabled = enabled;
    }

    if (Object.keys(payload).length === 0) {
      props.onClose();
      return;
    }

    try {
      await updatePolicy.mutateAsync({
        policyId: props.policy.id,
        payload,
      });
      props.onClose();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed updating policy.",
      );
    }
  };

  return (
    <div className="mt-3 border-t border-border/50 pt-3">
      {error && <ErrorBanner className="mb-3">{error}</ErrorBanner>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-2 sm:col-span-2">
          <Label>Resource pattern</Label>
          <Input
            value={pattern}
            onChange={(event) => setPattern(event.target.value)}
            placeholder="github.* or *.delete"
            className="h-8 font-mono text-[12px]"
            autoFocus
          />
        </div>
        <div className="grid gap-2">
          <Label>Permission</Label>
          <Select
            value={`${effect}:${approvalMode}`}
            onChange={(event) => {
              const [newEffect, newApproval] = event.target.value.split(":") as [
                LocalScopePolicyEffect,
                LocalScopePolicyApprovalMode,
              ];
              setEffect(newEffect);
              setApprovalMode(newApproval);
            }}
            className="h-8 text-[12px]"
          >
            <option value="allow:auto">Auto-run</option>
            <option value="allow:required">Requires approval</option>
            <option value="deny:auto">Denied</option>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label>Priority</Label>
          <Input
            type="number"
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
            placeholder="0"
            className="h-8 text-[12px]"
          />
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="rounded border-border"
          />
          Enabled
        </label>
        <div className="flex items-center gap-2">
          <PermissionBadge effect={effect} approvalMode={approvalMode} />
          <Button variant="ghost" size="sm" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={updatePolicy.status === "pending"}
          >
            {updatePolicy.status === "pending" && (
              <IconSpinner className="size-3" />
            )}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Shared components ───────────────────────────────────────────────────

function HelpCard(props: { level: PermissionLevel; children: ReactNode }) {
  const config = permissionConfig[props.level];

  return (
    <div
      className={cn(
        "rounded-xl border px-4 py-3 text-[12px] leading-relaxed",
        config.className,
      )}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className={cn("size-2 rounded-full", config.dotClassName)} />
        <span className="text-[10px] font-semibold uppercase tracking-wide">
          {config.label}
        </span>
      </div>
      <p className="text-foreground/70">{props.children}</p>
    </div>
  );
}

function FormCard(props: {
  title: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cn("border-primary/20 p-0", props.className)}>
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h3 className="text-sm font-semibold text-foreground">{props.title}</h3>
        <Button variant="ghost" size="sm" onClick={props.onClose}>
          Cancel
        </Button>
      </div>
      <div className="space-y-4 p-5">{props.children}</div>
    </Card>
  );
}

function ErrorBanner(props: { children: ReactNode; className?: string }) {
  return (
    <Alert
      variant="destructive"
      className={cn("text-[13px]", props.className)}
    >
      {props.children}
    </Alert>
  );
}

function SectionEmptyState(props: {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
      <p className="text-[14px] font-medium text-foreground/75">
        {props.title}
      </p>
      <p className="mt-1 text-[13px] text-muted-foreground">
        {props.description}
      </p>
      {props.actionLabel && props.onAction && (
        <div className="mt-4 flex justify-center">
          <Button size="sm" onClick={props.onAction}>
            <IconPlus className="size-3.5" />
            {props.actionLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

const formatDate = (value: number): string =>
  new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
