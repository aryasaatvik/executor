const { spawn } = require("node:child_process");
const { resolve } = require("node:path");

const root = resolve(__dirname, "..");

// First bundle the Electron main process.
const build = spawn("npm", ["run", "build"], { cwd: root, stdio: "inherit" });

build.on("exit", (code) => {
  if (code !== 0) {
    console.error("Desktop main build failed");
    process.exit(1);
  }

  // Then launch Electron
  const electron = spawn("npx", ["electron", "."], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "development" },
  });

  electron.on("exit", (code) => {
    process.exit(code ?? 0);
  });
});
