// vite.ts
import { fileURLToPath } from "url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import executorVitePlugin from "@executor-js/vite-plugin";
var APP_ROOT = fileURLToPath(new URL("./", import.meta.url));
function appPlugin(options = {}) {
  return [
    {
      name: "executor-app:config",
      config() {
        return {
          resolve: {
            alias: {
              "@executor-app": APP_ROOT
            },
            dedupe: ["react", "react-dom"]
          }
        };
      }
    },
    tailwindcss(),
    executorVitePlugin({
      ...options.executorConfigPath ? { configPath: options.executorConfigPath } : {},
      ...options.executorJsoncPath ? { jsoncPath: options.executorJsoncPath } : {}
    }),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: fileURLToPath(new URL("./src/routes", import.meta.url)),
      generatedRouteTree: fileURLToPath(new URL("./src/routeTree.gen.ts", import.meta.url))
    }),
    ...react()
  ];
}
export {
  appPlugin as default
};
