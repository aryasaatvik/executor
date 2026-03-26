import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./route-tree.gen";

export const getRouter = () => {
  const router = createRouter({
    routeTree,
    defaultPreload: "intent",
  });

  return router;
};
