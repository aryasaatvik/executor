import { NodeFileSystem } from "@effect/platform-node";
import type {
  AccountId,
  WorkspaceId,
} from "@executor/control-plane/model";
import type { WorkspaceConfigShape } from "@executor/control-plane/ports";
import * as Effect from "effect/Effect";

import { resolveLocalWorkspaceContext } from "./config";
import { deriveLocalInstallation } from "./installation";

export type LocalWorkspaceConfigOptions = {
  readonly cwd?: string;
  readonly workspaceRoot?: string;
};

type LocalIdentity = {
  readonly workspaceId: WorkspaceId;
  readonly accountId: AccountId;
};

export const createLocalWorkspaceConfig = (
  options: LocalWorkspaceConfigOptions = {},
): WorkspaceConfigShape => {
  let cachedIdentity: LocalIdentity | null = null;

  const resolveIdentity = (): Effect.Effect<LocalIdentity, Error> =>
    Effect.gen(function* () {
      if (cachedIdentity !== null) {
        return cachedIdentity;
      }

      const context = yield* resolveLocalWorkspaceContext({
        cwd: options.cwd,
        workspaceRoot: options.workspaceRoot,
      }).pipe(Effect.provide(NodeFileSystem.layer));
      const installation = deriveLocalInstallation(context);
      const identity = {
        workspaceId: installation.workspaceId,
        accountId: installation.accountId,
      } satisfies LocalIdentity;

      cachedIdentity = identity;
      return identity;
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error
          ? cause
          : new Error(String(cause ?? "failed to resolve local workspace identity")),
      ),
    );

  return {
    getWorkspaceId: () => resolveIdentity().pipe(Effect.map((identity) => identity.workspaceId)),
    getAccountId: () => resolveIdentity().pipe(Effect.map((identity) => identity.accountId)),
  };
};
