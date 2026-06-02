import { defineConfig } from "tsup";

/**
 * Compiles ONLY the Vite plugin entry (`vite.ts` -> `vite.js`).
 *
 * The rest of `@executor-js/app` ships as source (`.tsx`) because Vite
 * bundles the app source itself in the consumer build. The `./vite`
 * entry, however, is imported by Node (consumer `vite.config.ts`) from
 * inside `node_modules`, where Node refuses to type-strip a raw `.ts`
 * file (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). So we precompile
 * just this one entry to plain JS with every import left external.
 *
 * Output lands at the package root (`vite.js`) rather than `dist/`,
 * because `dist/` is owned by the SPA `vite build` output and
 * `vite build` empties it.
 */
export default defineConfig({
  entry: { vite: "vite.ts" },
  outDir: ".",
  format: ["esm"],
  dts: false,
  sourcemap: false,
  clean: false,
  // Leave every import external — consumers resolve these from their own
  // (or this package's) dependency tree. We only want to strip types.
  // Node builtins are external by default; the rest are this entry's
  // direct imports (Vite plugins + the executor vite plugin).
  external: [
    /^@executor-js\//,
    /^@vitejs\//,
    /^@tailwindcss\//,
    /^@tanstack\//,
    "vite",
  ],
});
