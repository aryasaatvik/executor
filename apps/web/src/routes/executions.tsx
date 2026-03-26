import { createFileRoute } from "@tanstack/react-router";
import { ExecutionsPage } from "../views/executions";

export const Route = createFileRoute("/executions")({
  component: ExecutionsPage,
});
