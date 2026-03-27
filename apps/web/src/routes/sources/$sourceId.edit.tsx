import { createFileRoute } from "@tanstack/react-router";
import { EditSourcePage } from "../../views/source-editor";

export const Route = createFileRoute("/sources/$sourceId/edit")({
  component: EditSourceRouteComponent,
});

function EditSourceRouteComponent() {
  const { sourceId } = Route.useParams();
  return <EditSourcePage sourceId={sourceId} />;
}
