import { randomUUID } from "node:crypto";
import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite";
import { and, asc, eq } from "drizzle-orm";
import * as Effect from "effect/Effect";

import type {
  CreatePolicyPayload,
  UpdatePolicyPayload,
} from "../../api/policies/api";
import { policy } from "../../db/schema";
import {
  ControlPlaneBadRequestError,
  ControlPlaneNotFoundError,
  ControlPlaneStorageError,
} from "../../api/errors";
import { PolicyIdSchema, type LocalWorkspacePolicy, type PolicyId, type WorkspaceId } from "#schema";
import { requireRuntimeLocalWorkspace } from "../local/runtime-context";
import { WorkspaceDatabase } from "../local/workspace-database";
import {
  type OperationErrors,
  operationErrors,
} from "./operation-errors";


const policyOps = {
  list: operationErrors("policies.list"),
  create: operationErrors("policies.create"),
  get: operationErrors("policies.get"),
  update: operationErrors("policies.update"),
  remove: operationErrors("policies.remove"),
} as const;

const defaultPolicyResourcePattern = "*";
const defaultPolicyEffect = "allow" as const;
const defaultPolicyApprovalMode = "auto" as const;
const defaultPolicyPriority = 0;

const basePolicySlug = (input: {
  resourcePattern: string;
  effect: "allow" | "deny";
  approvalMode: "auto" | "required";
}): string => {
  const trimmedPattern = input.resourcePattern.trim();
  if (trimmedPattern.length > 0) {
    return trimmedPattern;
  }

  return `${input.effect}-${input.approvalMode}`;
};

const nextAvailablePolicySlug = (
  base: string,
  existing: ReadonlySet<string>,
): string => {
  if (!existing.has(base)) {
    return base;
  }

  let counter = 2;
  let candidate = `${base}-${counter}`;
  while (existing.has(candidate)) {
    counter += 1;
    candidate = `${base}-${counter}`;
  }
  return candidate;
};

const loadWorkspacePolicyContext = (
  operation: OperationErrors,
  workspaceId: WorkspaceId,
) =>
  requireRuntimeLocalWorkspace(workspaceId).pipe(
    Effect.mapError((cause) =>
      operation.notFound(
        "Workspace not found",
        cause instanceof Error ? cause.message : String(cause),
      ),
    ),
  );

const isHandledPolicyError = (
  cause: unknown,
): cause is
  | ControlPlaneBadRequestError
  | ControlPlaneNotFoundError
  | ControlPlaneStorageError =>
  cause instanceof ControlPlaneBadRequestError
  || cause instanceof ControlPlaneNotFoundError
  || cause instanceof ControlPlaneStorageError;

const withWorkspacePolicyDb = <A, E>(
  input: {
    workspaceId: WorkspaceId;
    operation: OperationErrors;
    run: (db: Effect.Effect.Success<typeof SqliteDrizzle>) => Effect.Effect<A, E, never>;
  },
) =>
  Effect.gen(function* () {
    yield* loadWorkspacePolicyContext(
      input.operation,
      input.workspaceId,
    );
    const workspaceDatabase = yield* WorkspaceDatabase;

    return yield* workspaceDatabase.provideWrite(Effect.gen(function* () {
      const db = yield* SqliteDrizzle;
      return yield* input.run(db);
    })).pipe(
      Effect.mapError((cause) =>
        isHandledPolicyError(cause)
          ? cause
          : input.operation.unknownStorage(
              cause,
              `Failed operating on workspace policies in ${input.workspaceId}`,
            ),
      ),
    );
  });

export const loadRuntimeLocalWorkspacePolicies = (workspaceId: WorkspaceId) =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* loadWorkspacePolicyContext(
      policyOps.list,
      workspaceId,
    );
    const policies = yield* withWorkspacePolicyDb({
      workspaceId,
      operation: policyOps.list,
      run: (db) =>
        db
          .select()
          .from(policy)
          .where(eq(policy.workspaceId, workspaceId))
          .orderBy(asc(policy.createdAt)),
    });

    return {
      runtimeLocalWorkspace,
      policies,
    };
  });

export const listPolicies = (workspaceId: WorkspaceId) =>
  Effect.map(
    loadRuntimeLocalWorkspacePolicies(workspaceId),
    ({ policies }) => policies,
  );

export const createPolicy = (input: {
  workspaceId: WorkspaceId;
  payload: CreatePolicyPayload;
}) =>
  withWorkspacePolicyDb({
    workspaceId: input.workspaceId,
    operation: policyOps.create,
    run: (db) =>
      Effect.gen(function* () {
        const now = Date.now();
        const resourcePattern =
          input.payload.resourcePattern ?? defaultPolicyResourcePattern;
        const effect = input.payload.effect ?? defaultPolicyEffect;
        const approvalMode =
          input.payload.approvalMode ?? defaultPolicyApprovalMode;
        const priority = input.payload.priority ?? defaultPolicyPriority;
        const enabled = input.payload.enabled ?? true;
        const existingSlugs = new Set(
          (
            yield* db
              .select({ slug: policy.slug })
              .from(policy)
              .where(eq(policy.workspaceId, input.workspaceId))
          ).map((row) => row.slug),
        );
        const slug = nextAvailablePolicySlug(
          basePolicySlug({
            resourcePattern,
            effect,
            approvalMode,
          }),
          existingSlugs,
        );
        const id = PolicyIdSchema.make(`pol_${randomUUID()}`);

        const nextPolicy = {
          id,
          slug,
          workspaceId: input.workspaceId,
          resourcePattern,
          effect,
          approvalMode,
          priority,
          enabled,
          createdAt: now,
          updatedAt: now,
        } satisfies LocalWorkspacePolicy;

        yield* db.insert(policy).values(nextPolicy);

        return nextPolicy;
      }),
  });

export const getPolicy = (input: {
  workspaceId: WorkspaceId;
  policyId: PolicyId;
}) =>
  withWorkspacePolicyDb({
    workspaceId: input.workspaceId,
    operation: policyOps.get,
    run: (db) =>
      Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(policy)
          .where(
            and(
              eq(policy.id, input.policyId),
              eq(policy.workspaceId, input.workspaceId),
            ),
          )
          .limit(1);
        const resolved = rows[0] ?? null;

        if (resolved === null) {
          return yield* policyOps.get.notFound(
            "Policy not found",
            `workspaceId=${input.workspaceId} policyId=${input.policyId}`,
          );
        }

        return resolved;
      }),
  });

export const updatePolicy = (input: {
  workspaceId: WorkspaceId;
  policyId: PolicyId;
  payload: UpdatePolicyPayload;
}) =>
  withWorkspacePolicyDb({
    workspaceId: input.workspaceId,
    operation: policyOps.update,
    run: (db) =>
      Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(policy)
          .where(
            and(
              eq(policy.id, input.policyId),
              eq(policy.workspaceId, input.workspaceId),
            ),
          )
          .limit(1);
        const existing = rows[0] ?? null;

        if (existing === null) {
          return yield* policyOps.update.notFound(
            "Policy not found",
            `workspaceId=${input.workspaceId} policyId=${input.policyId}`,
          );
        }

        const updatedAt = Date.now();
        const nextPolicy: LocalWorkspacePolicy = {
          ...existing,
          ...(input.payload.resourcePattern !== undefined
            ? { resourcePattern: input.payload.resourcePattern }
            : {}),
          ...(input.payload.effect !== undefined
            ? { effect: input.payload.effect }
            : {}),
          ...(input.payload.approvalMode !== undefined
            ? { approvalMode: input.payload.approvalMode }
            : {}),
          ...(input.payload.priority !== undefined
            ? { priority: input.payload.priority }
            : {}),
          ...(input.payload.enabled !== undefined
            ? { enabled: input.payload.enabled }
            : {}),
          updatedAt,
        };

        yield* db
          .update(policy)
          .set(nextPolicy)
          .where(
            and(
              eq(policy.id, input.policyId),
              eq(policy.workspaceId, input.workspaceId),
            ),
          );

        return nextPolicy;
      }),
  });

export const removePolicy = (input: {
  workspaceId: WorkspaceId;
  policyId: PolicyId;
}) =>
  withWorkspacePolicyDb({
    workspaceId: input.workspaceId,
    operation: policyOps.remove,
    run: (db) =>
      Effect.gen(function* () {
        const existing = yield* db
          .select({ id: policy.id })
          .from(policy)
          .where(
            and(
              eq(policy.id, input.policyId),
              eq(policy.workspaceId, input.workspaceId),
            ),
          )
          .limit(1);
        if (!existing[0]) {
          return { removed: false };
        }

        yield* db.delete(policy).where(
          and(
            eq(policy.id, input.policyId),
            eq(policy.workspaceId, input.workspaceId),
          ),
        );
        return { removed: true };
      }),
  });
