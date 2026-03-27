import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SourceDetailPage } from "../../views/source-detail";

type SourceRouteSearch = {
  tab: "model" | "discover";
  tool?: string;
  query?: string;
};

const sourceTabs = ["model", "discover"] as const;

export const Route = createFileRoute("/sources/$sourceId")({
  validateSearch: (search: Record<string, unknown>): SourceRouteSearch => ({
    tab:
      typeof search.tab === "string" &&
      sourceTabs.includes(search.tab as SourceRouteSearch["tab"])
        ? (search.tab as SourceRouteSearch["tab"])
        : "model",
    tool:
      typeof search.tool === "string" && search.tool.length > 0
        ? search.tool
        : undefined,
    query: typeof search.query === "string" ? search.query : undefined,
  }),
  component: SourceDetailRouteComponent,
});

function SourceDetailRouteComponent() {
  const { sourceId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <SourceDetailPage
      sourceId={sourceId}
      search={search}
      navigate={navigate as any}
    />
  );
}
