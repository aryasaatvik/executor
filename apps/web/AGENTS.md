# Web App Agents

## Stack

- React 19
- TanStack Start + file-based routes
- Vite + Cloudflare Workers plugin
- Tailwind v4 + tw-animate-css
- `@executor/react` REST hooks

## Entry points

```
src/
  start.tsx       — TanStack Start instance
  server.ts       — Workers server entry
  router.tsx      — createRouter(routeTree)
  route-tree.gen.ts — generated route tree
  globals.css     — global theme + fonts
```

## Directory Structure

```
src/
  routes/
    __root.tsx
    index.tsx
    executions.tsx
    secrets.tsx
    settings.tsx
    sources/
      add.tsx
      new.tsx
      $sourceId.tsx
      $sourceId.edit.tsx
  views/
    dashboard.tsx
    executions.tsx
    source-detail.tsx
    source-editor.tsx
    add-source.tsx
    secrets.tsx
    settings.tsx
  components/
    shell.tsx
    loadable.tsx
    ui/
```

## Routing

- Root route wraps `AppShell` in `ExecutorReactProvider`
- Active routes:
  - `/`
  - `/executions`
  - `/secrets`
  - `/settings`
  - `/sources/add`
  - `/sources/new`
  - `/sources/$sourceId`
  - `/sources/$sourceId/edit`

## API / State Layer

- `@executor/react` is plain fetch-based, not Effect RPC
- Hooks now target the real server API shape:
  - `/discover`
  - `/health`
  - `/v1/local/*`
  - `/v1/workspaces/:workspaceId/*`
  - `/v1/sources/discover`
- `useLocalInstallation()` resolves the workspace scope that other hooks build on
- All hooks return `Loadable<T>`

## Notes

- `apps/web` typechecks and builds cleanly
- There is still a duplicated generated artifact risk if `routeTree.gen.ts` reappears; the active generated file is `route-tree.gen.ts`
