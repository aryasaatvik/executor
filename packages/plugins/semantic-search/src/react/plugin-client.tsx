import { defineClientPlugin } from "@executor-js/sdk/client";
import { lazy } from "react";

const SearchPage = lazy(() =>
  import("./SearchPage").then((module) => ({ default: module.SearchPage })),
);

// Registers the "Search" sidebar tab + its page. The host mounts this under
// `/plugins/semanticSearch`. Mirrors execution-history's `./client` entry.
export default defineClientPlugin({
  id: "semanticSearch" as const,
  pages: [
    {
      path: "/",
      component: SearchPage,
      nav: { label: "Search" },
    },
  ],
});
