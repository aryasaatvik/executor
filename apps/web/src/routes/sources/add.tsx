import { createFileRoute } from "@tanstack/react-router";
import { AddSourcePage } from "../../views/add-source";

export const Route = createFileRoute("/sources/add")({
  component: AddSourcePage,
});
