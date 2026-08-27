---
"@executor-js/cloudflare": minor
"@executor-js/host-cloudflare": minor
"@executor-js/plugin-service-tokens": minor
"@executor-js/api": minor
"@executor-js/sdk": minor
---

Add a service-token alias plugin and integrate it with the Cloudflare Access
host. Service-token runs retain a stable machine actor across MCP session cold
restores while aliases provide friendly names and optional acting-as identities.
Expose a host-internal, read-only org plugin-storage lookup so identity adapters
can resolve aliases before constructing a scoped Executor.
