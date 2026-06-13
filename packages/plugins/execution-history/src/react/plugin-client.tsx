import { defineClientPlugin } from "@executor-js/sdk/client";
import { lazy } from "react";

const RunsPage = lazy(() => import("./RunsPage").then((module) => ({ default: module.RunsPage })));

export default defineClientPlugin({
  id: "executionHistory" as const,
  pages: [
    {
      path: "/",
      component: RunsPage,
      nav: { label: "Runs" },
    },
  ],
});
