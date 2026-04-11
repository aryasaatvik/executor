import { describe, expect, it } from "@effect/vitest";

import {
  copyLegacyFileIfMissing,
  resolveExecutorPaths,
  type LegacyFileCopyFileSystem,
} from "./platform-paths";

describe("resolveExecutorPaths", () => {
  it("uses Application Support on macOS", () => {
    const paths = resolveExecutorPaths({
      platform: "darwin",
      env: {},
      homeDir: "/Users/saatvik",
    });

    expect(paths.dataDir).toBe("/Users/saatvik/Library/Application Support/Executor");
    expect(paths.configDir).toBe("/Users/saatvik/Library/Application Support/Executor");
    expect(paths.runtimeDbPath).toBe("/Users/saatvik/Library/Application Support/Executor/data.db");
    expect(paths.desktopSettingsPath).toBe(
      "/Users/saatvik/Library/Application Support/Executor/desktop-settings.json",
    );
    expect(paths.legacyRuntimeDbPath).toBe("/Users/saatvik/.executor/data.db");
  });

  it("uses XDG data and config directories on Linux", () => {
    const paths = resolveExecutorPaths({
      platform: "linux",
      env: {
        XDG_DATA_HOME: "/var/data",
        XDG_CONFIG_HOME: "/var/config",
      },
      homeDir: "/home/saatvik",
    });

    expect(paths.dataDir).toBe("/var/data/executor");
    expect(paths.configDir).toBe("/var/config/executor");
    expect(paths.runtimeDbPath).toBe("/var/data/executor/data.db");
    expect(paths.desktopSettingsPath).toBe("/var/config/executor/desktop-settings.json");
  });

  it("falls back to home-relative XDG paths on Linux", () => {
    const paths = resolveExecutorPaths({
      platform: "linux",
      env: {},
      homeDir: "/home/saatvik",
    });

    expect(paths.dataDir).toBe("/home/saatvik/.local/share/executor");
    expect(paths.configDir).toBe("/home/saatvik/.config/executor");
  });

  it("uses APPDATA on Windows", () => {
    const paths = resolveExecutorPaths({
      platform: "win32",
      env: {
        APPDATA: "C:\\Users\\Saatvik\\AppData\\Roaming",
      },
      homeDir: "C:\\Users\\Saatvik",
    });

    expect(paths.dataDir).toBe("C:\\Users\\Saatvik\\AppData\\Roaming\\Executor");
    expect(paths.configDir).toBe("C:\\Users\\Saatvik\\AppData\\Roaming\\Executor");
    expect(paths.runtimeDbPath).toBe("C:\\Users\\Saatvik\\AppData\\Roaming\\Executor\\data.db");
    expect(paths.desktopSettingsPath).toBe(
      "C:\\Users\\Saatvik\\AppData\\Roaming\\Executor\\desktop-settings.json",
    );
    expect(paths.legacyCliBinPath).toBe("C:\\Users\\Saatvik\\.executor\\bin\\executor.exe");
  });

  it("falls back to AppData Roaming on Windows", () => {
    const paths = resolveExecutorPaths({
      platform: "win32",
      env: {},
      homeDir: "C:\\Users\\Saatvik",
    });

    expect(paths.dataDir).toBe("C:\\Users\\Saatvik\\AppData\\Roaming\\Executor");
  });

  it("lets EXECUTOR_DATA_DIR override runtime data only", () => {
    const paths = resolveExecutorPaths({
      platform: "linux",
      env: {
        XDG_DATA_HOME: "/var/data",
        XDG_CONFIG_HOME: "/var/config",
        EXECUTOR_DATA_DIR: "/override/data",
      },
      homeDir: "/home/saatvik",
    });

    expect(paths.dataDir).toBe("/override/data");
    expect(paths.runtimeDbPath).toBe("/override/data/data.db");
    expect(paths.configDir).toBe("/var/config/executor");
    expect(paths.desktopSettingsPath).toBe("/var/config/executor/desktop-settings.json");
  });
});

describe("copyLegacyFileIfMissing", () => {
  const makeFs = (existingPaths: ReadonlyArray<string>) => {
    const existing = new Set(existingPaths);
    const calls: string[] = [];
    const fs: LegacyFileCopyFileSystem = {
      existsSync: (path) => existing.has(path),
      mkdirSync: (path) => {
        calls.push(`mkdir:${path}`);
      },
      copyFileSync: (source, target) => {
        calls.push(`copy:${source}:${target}`);
        existing.add(target);
      },
    };

    return { calls, fs };
  };

  it("copies a legacy file when the target is absent", () => {
    const { calls, fs } = makeFs(["/home/saatvik/.executor/data.db"]);

    const result = copyLegacyFileIfMissing({
      legacyPath: "/home/saatvik/.executor/data.db",
      targetPath: "/home/saatvik/.local/share/executor/data.db",
      fs,
    });

    expect(result).toBe("copied");
    expect(calls).toEqual([
      "mkdir:/home/saatvik/.local/share/executor",
      "copy:/home/saatvik/.executor/data.db:/home/saatvik/.local/share/executor/data.db",
    ]);
  });

  it("does not overwrite an existing target", () => {
    const { calls, fs } = makeFs([
      "/home/saatvik/.executor/data.db",
      "/home/saatvik/.local/share/executor/data.db",
    ]);

    const result = copyLegacyFileIfMissing({
      legacyPath: "/home/saatvik/.executor/data.db",
      targetPath: "/home/saatvik/.local/share/executor/data.db",
      fs,
    });

    expect(result).toBe("skipped-existing-target");
    expect(calls).toEqual([]);
  });

  it("does not copy when the legacy file is absent", () => {
    const { calls, fs } = makeFs([]);

    const result = copyLegacyFileIfMissing({
      legacyPath: "/home/saatvik/.executor/desktop-settings.json",
      targetPath: "/home/saatvik/.config/executor/desktop-settings.json",
      fs,
    });

    expect(result).toBe("skipped-missing-legacy");
    expect(calls).toEqual([]);
  });

  it("can be disabled for explicit runtime overrides", () => {
    const { calls, fs } = makeFs(["/home/saatvik/.executor/data.db"]);

    const result = copyLegacyFileIfMissing({
      legacyPath: "/home/saatvik/.executor/data.db",
      targetPath: "/override/data/data.db",
      enabled: false,
      fs,
    });

    expect(result).toBe("skipped-disabled");
    expect(calls).toEqual([]);
  });
});
