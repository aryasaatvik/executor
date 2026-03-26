import { createFileRoute } from "@tanstack/react-router";
import { NewSourcePage } from "../../views/source-editor";

export const Route = createFileRoute("/sources/new")({
  component: NewSourcePage,
});
