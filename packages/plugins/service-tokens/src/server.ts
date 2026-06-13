// ---------------------------------------------------------------------------
// @executor-js/plugin-service-tokens/server
//
// Server half: manage `common_name → subject` aliases for Cloudflare Access
// service tokens. Aliases are persisted in the shared `plugin_storage` table
// under the `org` owner (subject = ORG_SUBJECT) so they are tenant-shared and
// the host's pre-runtime auth seam can read them with only the tenant id.
//
// The host seam (apps/host-cloudflare/src/auth) reads these rows directly via
// the executor db handle at JWT-verify time — the contract it depends on is the
// stable triple (plugin_id = "service-tokens", collection = "aliases",
// owner = "org"). Keep those in sync if they ever change here.
//
// React and other browser-only deps live in `./client` — never here.
// ---------------------------------------------------------------------------

import {
  Context,
  definePlugin,
  Effect,
  HttpApi,
  HttpApiBuilder,
  StorageError,
  type Owner,
  type OwnerBinding,
  type PluginStorageFacade,
  type StorageFailure,
} from "@executor-js/sdk/core";
import { capture } from "@executor-js/api";

import { ServiceTokensApi, type ServiceTokenAlias } from "./shared";

/** Plugin-storage collection holding the alias rows. */
const COLLECTION = "aliases";
/** Aliases are tenant-shared so every principal (and the host auth seam) sees
 *  the same set regardless of who wrote them. */
const ALIAS_OWNER: Owner = "org";

interface AliasData {
  readonly subject: string;
}

// Bundle the group into a single-group HttpApi for typing only — the runtime
// merges by group identity into the host's FullApi.
const ServiceTokensApiBundle = HttpApi.make("serviceTokens").add(ServiceTokensApi);

const makeServiceTokensExtension = (ctx: {
  readonly owner: OwnerBinding;
  readonly pluginStorage: PluginStorageFacade;
}) => ({
  list: (): Effect.Effect<readonly ServiceTokenAlias[], StorageFailure> =>
    ctx.pluginStorage
      .list<AliasData>({ collection: COLLECTION })
      .pipe(
        Effect.map((entries) =>
          entries.map((entry) => ({ commonName: entry.key, subject: entry.data.subject })),
        ),
      ),

  // Alias the given token to the CALLER's own subject — a user can only map a
  // token to their own identity, never someone else's.
  alias: (commonName: string): Effect.Effect<ServiceTokenAlias, StorageFailure> =>
    Effect.gen(function* () {
      const subject = ctx.owner.subject;
      if (subject == null) {
        // Impossible for any authenticated caller (humans carry a sub, tokens a
        // common_name); surface a storage failure rather than write a null
        // alias — `capture` downgrades it to a 500 at the HTTP edge.
        return yield* new StorageError({
          message: "Cannot create alias: the caller has no subject.",
          cause: undefined,
        });
      }
      const subjectStr = String(subject);
      yield* ctx.pluginStorage.put<AliasData>({
        collection: COLLECTION,
        key: commonName,
        owner: ALIAS_OWNER,
        data: { subject: subjectStr },
      });
      return { commonName, subject: subjectStr };
    }),

  unalias: (commonName: string): Effect.Effect<{ readonly ok: boolean }, StorageFailure> =>
    ctx.pluginStorage
      .remove({ collection: COLLECTION, key: commonName, owner: ALIAS_OWNER })
      .pipe(Effect.as({ ok: true })),
});

type ServiceTokensExtension = ReturnType<typeof makeServiceTokensExtension>;

export class ServiceTokensExtensionService extends Context.Service<
  ServiceTokensExtensionService,
  ServiceTokensExtension
>()("ServiceTokensExtensionService") {}

// Each handler yields the extension, calls the method, returns. `capture`
// downgrades the storage layer's `StorageFailure` to the shared `InternalError`
// (500) declared on the endpoints — keeping typed errors in the channel rather
// than collapsing them with an escape hatch.
const ServiceTokensHandlers = HttpApiBuilder.group(ServiceTokensApiBundle, "serviceTokens", (h) =>
  h
    .handle("list", () =>
      capture(
        Effect.gen(function* () {
          const ext = yield* ServiceTokensExtensionService;
          return yield* ext.list();
        }),
      ),
    )
    .handle("alias", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* ServiceTokensExtensionService;
          return yield* ext.alias(payload.commonName);
        }),
      ),
    )
    .handle("unalias", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const ext = yield* ServiceTokensExtensionService;
          return yield* ext.unalias(payload.commonName);
        }),
      ),
    ),
);

export const serviceTokensPlugin = definePlugin(() => ({
  id: "service-tokens" as const,
  packageName: "@executor-js/plugin-service-tokens",

  // No in-memory store — alias rows live in `plugin_storage` via `pluginStorage`.
  storage: () => ({}),

  extension: makeServiceTokensExtension,

  routes: () => ServiceTokensApi,
  handlers: () => ServiceTokensHandlers,
  extensionService: ServiceTokensExtensionService,
}));

export default serviceTokensPlugin;
