import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    main: "src/main.ts",
  },
  format: ["cjs"],
  platform: "node",
  target: "node22",
  external: ["electron"],
  sourcemap: true,
  clean: true,
});
