import { createFileRoute } from "@tanstack/react-router";
import { SecretsPage } from "../views/secrets";

export const Route = createFileRoute("/secrets")({
  component: SecretsPage,
});
