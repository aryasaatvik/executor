import { Link } from "@tanstack/react-router";
import {
  useRebuildSearchProvider,
  useRefreshSearchProvider,
  useSearchProviderStatus,
  useSources,
  type SearchProviderStatus,
} from "@executor/react";
import { sourcePluginsIndexPath } from "@executor/react/plugins";
import { LoadableBlock } from "../components/loadable";
import { LocalMcpInstallCard } from "../components/local-mcp-install-card";
import { SourceFavicon } from "../components/source-favicon";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@executor/react/plugins";
import { IconSources, IconPlus, IconSpinner } from "../components/icons";
import {
  getSourceFrontendPaths,
} from "../plugins";

const statusVariant = (status: string) =>
  status === "connected"
    ? "default" as const
    : status === "error"
      ? "destructive" as const
      : "muted" as const;

const searchStatusVariant = (status: SearchProviderStatus) =>
  status.healthy
    ? status.fallbackUsed === true
      ? "secondary" as const
      : "default" as const
    : "destructive" as const;

const formatSearchCount = (value: number | undefined) =>
  value === undefined ? "—" : value.toLocaleString();

function SearchProviderCard() {
  const status = useSearchProviderStatus();
  const refreshSearchProvider = useRefreshSearchProvider();
  const rebuildSearchProvider = useRebuildSearchProvider();

  if (status.status === "loading") {
    return (
      <Card className="rounded-2xl">
        <CardHeader className="border-b border-border/60">
          <CardTitle>Workspace search</CardTitle>
          <CardDescription>
            Search provider status and index operations for this workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3 py-8 text-sm text-muted-foreground">
          <IconSpinner />
          Loading search status...
        </CardContent>
      </Card>
    );
  }

  if (status.status === "error") {
    return (
      <Card className="rounded-2xl">
        <CardHeader className="border-b border-border/60">
          <CardTitle>Workspace search</CardTitle>
          <CardDescription>
            Search provider status and index operations for this workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-0">
          <Alert variant="destructive">
            {status.error.message}
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const data = status.data;
  const alertVariant = data.healthy ? "warning" as const : "destructive" as const;
  const detail =
    data.detail ?? (data.fallbackUsed ? "Search results are currently using a fallback provider." : null);

  return (
    <Card className="rounded-2xl">
      <CardHeader className="border-b border-border/60">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Workspace search</CardTitle>
            <CardDescription>
              Search provider status and index operations for this workspace.
            </CardDescription>
          </div>
          <Badge variant={searchStatusVariant(data)}>
            {data.healthy ? (data.fallbackUsed ? "Fallback" : "Healthy") : "Degraded"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Provider" value={data.providerKey} />
          <StatTile label="Configured" value={data.configuredProviderKey} />
          <StatTile label="Backend" value={data.backend} />
          <StatTile label="Mode" value={data.mode} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile label="Sources" value={formatSearchCount(data.sourceCount)} />
          <StatTile label="Documents" value={formatSearchCount(data.documentCount)} />
          <StatTile label="Stale sources" value={formatSearchCount(data.staleSourceCount)} />
        </div>
        {detail && (
          <Alert variant={alertVariant}>
            {detail}
          </Alert>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12px] text-muted-foreground">
          Refresh syncs the active provider. Rebuild regenerates the search index.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void refreshSearchProvider.mutateAsync(undefined);
            }}
            disabled={refreshSearchProvider.status === "pending"}
          >
            {refreshSearchProvider.status === "pending" ? (
              <IconSpinner className="size-3.5" />
            ) : null}
            Refresh
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              void rebuildSearchProvider.mutateAsync(undefined);
            }}
            disabled={rebuildSearchProvider.status === "pending"}
          >
            {rebuildSearchProvider.status === "pending" ? (
              <IconSpinner className="size-3.5" />
            ) : null}
            Rebuild
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

function StatTile(props: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-muted/20 px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {props.label}
      </div>
      <div className="mt-1 text-sm font-medium text-foreground">
        {props.value}
      </div>
    </div>
  );
}

export function HomePage() {
  const sources = useSources();

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
        {/* Header */}
        <div className="flex items-end justify-between mb-8">
          <div>
            <h1 className="font-display text-3xl tracking-tight text-foreground lg:text-4xl">
              Sources
            </h1>
            <p className="mt-1.5 text-[14px] text-muted-foreground">
              Connected tool providers in this workspace.
            </p>
          </div>
          <Link to={sourcePluginsIndexPath}>
            <Button size="sm">
              <IconPlus className="size-3.5" />
              Add source
            </Button>
          </Link>
        </div>

        <div className="mb-8">
          <SearchProviderCard />
        </div>

        <LocalMcpInstallCard className="mb-8" />

        {/* Source list */}
        <LoadableBlock loadable={sources} loading="Loading sources...">
          {(items) =>
            !Array.isArray(items) ? (
              <Alert variant="destructive" className="px-5 py-4">
                Sources returned an unexpected payload.
              </Alert>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20">
                <div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground mb-4">
                  <IconSources className="size-5" />
                </div>
                <p className="text-[14px] font-medium text-foreground/70 mb-1">
                  No sources yet
                </p>
                <p className="text-[13px] text-muted-foreground/60 mb-5">
                  Add a source to get started.
                </p>
                <Link to={sourcePluginsIndexPath}>
                  <Button size="sm">
                    <IconPlus className="size-3.5" />
                    Add source
                  </Button>
                </Link>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((source) => {
                  const paths = getSourceFrontendPaths(source.kind);
                  const card = (
                    <Card className="flex h-full flex-col rounded-2xl px-5 py-4 transition-colors hover:border-primary/25 hover:bg-card/90">
                      <div className="flex items-start gap-3">
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                          <SourceFavicon source={source} className="size-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <div className="truncate text-sm font-semibold text-foreground">
                              {source.name}
                            </div>
                            <Badge variant={statusVariant(source.status)} className="shrink-0">
                              {source.status}
                            </Badge>
                          </div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {source.kind}
                          </div>
                        </div>
                      </div>
                    </Card>
                  );

                  if (!paths) {
                    return (
                      <div key={source.id}>
                        {card}
                      </div>
                    );
                  }

                  return (
                    <Link
                      key={source.id}
                      to={paths.detail(source.id)}
                      search={{ tab: "model" }}
                    >
                      {card}
                    </Link>
                  );
                })}
              </div>
            )
          }
        </LoadableBlock>
      </div>
    </div>
  );
}
