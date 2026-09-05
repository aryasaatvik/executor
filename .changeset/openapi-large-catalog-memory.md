---
"@executor-js/sdk": patch
"@executor-js/plugin-openapi": patch
"@executor-js/fumadb": patch
---

Reduce large OpenAPI import memory by compiling operation bindings in chunks and filtering integration storage prefixes in SQL. Construct D1 upsert statements lazily in bounded native batches.
