# @executor-js/docs

The Executor documentation site, built with [Mintlify](https://mintlify.com).

## Develop

```bash
bun install
bun run dev   # mint dev — http://localhost:3000
```

Edit the `.mdx` pages and the navigation in [`docs.json`](./docs.json); the dev
server hot-reloads. Run `bun run broken-links` to validate internal links.

## How it's served

Mintlify hosts the built site at `executor.mintlify.dev`. The Executor Cloud
worker reverse-proxies it onto the first-party origin at `executor.sh/docs`
(see `apps/cloud/src/edge/docs.ts`), so the public docs live at
`executor.sh/docs` instead of a `*.mintlify.dev` subdomain.

To deploy from this directory, point the Mintlify GitHub app at `apps/docs`.
