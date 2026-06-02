import { defineConfig } from "tsup";

// Bundle to a single CLI entry. `effect` and `@effect/*` stay external so the
// installed CLI resolves them from its own node_modules (they are runtime
// dependencies). The shebang in src/main.ts is preserved by tsup for the bin.
export default defineConfig({
  entry: {
    main: "src/main.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: true,
  sourcemap: true,
  clean: true,
  external: [/^effect/, /^@effect\//],
});
