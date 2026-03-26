# Web App Agents

## Stack
- React 19 + Vite (bunx --bun vite dev)
- TanStack Router (file-based route tree defined in `src/main.tsx`)
- Tailwind v4 + tw-animate-css (CSS-first config in `src/globals.css`)
- `@executor/react` from `packages/clients/react` (workspace:* dep)
- `@executor/engine/client` for API calls (Effect-based RPC)

## Directory Structure
```
src/
  main.tsx        — Router tree + App entry (ExecutorReactProvider wraps RouterProvider)
  frontend.tsx    — Possibly alternative entry
  server.ts       — Production server entry
  globals.css     — Tailwind v4 theme (CSS @theme block), custom fonts (DM Sans, JetBrains Mono, Instrument Serif)
  components/
    shell.tsx     — AppShell: sidebar + Outlet. Sidebar has nav (Dashboard/Executions/Secrets/Settings) + source list
    loadable.tsx  — LoadableBlock: renders {loading, error, ready} states from @executor/react Loadable type
    ui/           — Button, Badge variants (cva + clsx + tailwind-merge)
    code-block.tsx, document-panel.tsx, markdown.tsx, icons.tsx, etc.
  views/
    dashboard.tsx     — DashboardPage: stats cards, top tools bar chart, recent executions, source grid
    executions.tsx    — ExecutionsPage: filter bar (status + search), stream-style row list, ExecutionDetailDrawer overlay
    source-detail.tsx — SourceDetailPage: tabbed (model/discover), tool list, search, document panel
    source-editor.tsx — EditSourcePage + NewSourcePage
    add-source.tsx    — AddSourcePage
    secrets.tsx       — SecretsPage
    settings.tsx      — SettingsPage
  lib/
    utils.ts     — cn() helper (clsx + twMerge)
    schema-display.ts, shiki.ts, source-favicon.ts
```

## Routing
- `rootRoute` -> `AppShell` component
- Child routes: `/` (DashboardPage), `/executions` (ExecutionsPage), `/sources/new`, `/sources/add`, `/sources/$sourceId`, `/sources/$sourceId/edit`, `/secrets`, `/settings`
- `SourceRouteSearch` type: `{ tab: "model"|"discover", tool?: string, query?: string }` — validated on `sourceRoute`

## API / State Layer
- `ExecutorReactProvider` wraps the app — provides `RegistryProvider` (effect-atom/atom-react) + query context
- Default base URL: `window.location.origin` in browser, `http://127.0.0.1:8788` fallback
- All data hooks return `Loadable<T>`: `{ status: "loading" } | { status: "error", error: Error } | { status: "ready", data: T }`
- Family atoms for: sources, source, sourceInspection, sourceInspectionTool, sourceDiscovery, executions, executionSteps, secrets, instanceConfig, localInstallation, workspaceOauthClients
- Mutations (`useCreateSource`, `useUpdateSource`, `useRemoveSource`, `useConnectSource`, etc.) use optimistic updates with rollback via effect-atom registry cache
- `invalidateTrackedQueries()` selectively refreshes atoms after mutations

## Key UI Patterns
- Sidebar: `w-52` fixed, source list with status dot (color-coded), "Add" button links to `/sources/add`
- Source favicon: resolved from endpoint + kind + iconUrl via `lib/source-favicon.ts`
- `LoadableBlock` component unwraps Loadable and renders children with loading/error states
- Status colors: connected (primary), probing (amber), draft (muted), auth_required (amber), error (destructive)
- Code display: shiki for syntax highlighting (themes + langs from npm)
- Drawer overlay for execution details (ExecutionDetailDrawer)
