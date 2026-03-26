import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    tailwindcss(),
    tanstackStart({
      srcDirectory: "src",
      start: { entry: "./start.tsx" },
      server: { entry: "./server.ts" },
      tsr: {
        generatedRouteTree: "./src/route-tree.gen.ts",
        routesDirectory: "./src/routes",
      },
    }),
    react(),
    cloudflare({
      viteEnvironment: {
        name: "ssr",
      },
    }),
  ],
});
