import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "tool-server": "src/tool-server.ts",
    "in-memory-session-store": "src/in-memory-session-store.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [
    /^@executor-js\//,
    /^effect/,
    /^@effect\//,
    "@modelcontextprotocol/sdk",
    "@cfworker/json-schema",
    "zod",
  ],
});
