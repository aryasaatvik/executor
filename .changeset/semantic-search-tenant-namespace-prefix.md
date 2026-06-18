---
"@executor-js/plugin-semantic-search": patch
---

fix: don't default the operator search prefix filter to the tenant namespace

`executor.semanticSearch.search` (the operator `tools.search` surface) overloaded a
single `namespace` value as both the Vectorize tenant namespace (storage isolation)
and the optional integration/path-prefix filter. With no operator-supplied prefix it
defaulted the filter to the tenant namespace (e.g. `"default"`), so the provider's
`matchesNamespace` required every tool path to start with the tenant id and dropped
every result — search returned nothing for all queries despite a fully populated
index. The integration prefix is now applied only when explicitly provided; the
tenant namespace drives the store query alone and is still reported on the result page.
