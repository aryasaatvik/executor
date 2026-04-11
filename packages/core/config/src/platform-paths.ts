import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, posix, win32 } from "node:path";

export type ExecutorPlatform = NodeJS.Platform;

export type ExecutorPathEnv = Record<string, string | undefined>;

export interface ExecutorPathInputs {
  readonly platform: ExecutorPlatform;
  readonly env: ExecutorPathEnv;
  readonly homeDir: string;
}

export interface ExecutorPaths {
  readonly dataDir: string;
  readonly configDir: string;
  readonly runtimeDbPath: string;
  readonly desktopSettingsDir: string;
  readonly desktopSettingsPath: string;
  readonly legacyStateDir: string;
  readonly legacyRuntimeDbPath: string;
  readonly legacyDesktopSettingsPath: string;
  readonly legacyCliBinDir: string;
  readonly legacyCliBinPath: string;
}

export interface GetExecutorPathsOptions {
  readonly platform?: ExecutorPlatform;
  readonly env?: ExecutorPathEnv;
  readonly homeDir?: string;
}

export type LegacyFileCopyResult =
  | "copied"
  | "skipped-disabled"
  | "skipped-existing-target"
  | "skipped-missing-legacy";

export interface LegacyFileCopyFileSystem {
  readonly existsSync: (path: string) => boolean;
  readonly mkdirSync: (path: string, options: { readonly recursive: true }) => void;
  readonly copyFileSync: (source: string, target: string) => void;
}

export interface CopyLegacyFileIfMissingOptions {
  readonly legacyPath: string;
  readonly targetPath: string;
  readonly enabled?: boolean;
  readonly fs?: LegacyFileCopyFileSystem;
}

const APP_NAME = "Executor";
const LINUX_NAME = "executor";

const defaultFileSystem: LegacyFileCopyFileSystem = {
  existsSync,
  mkdirSync,
  copyFileSync,
};

const getPathModule = (platform: ExecutorPlatform) => (platform === "win32" ? win32 : posix);

const resolveBaseDirs = ({
  platform,
  env,
  homeDir,
}: ExecutorPathInputs): {
  readonly dataDir: string;
  readonly configDir: string;
} => {
  if (platform === "darwin") {
    const applicationSupportDir = posix.join(homeDir, "Library", "Application Support", APP_NAME);
    return {
      dataDir: applicationSupportDir,
      configDir: applicationSupportDir,
    };
  }

  if (platform === "win32") {
    const appData = env.APPDATA ?? win32.join(homeDir, "AppData", "Roaming");
    const appDataDir = win32.join(appData, APP_NAME);
    return {
      dataDir: appDataDir,
      configDir: appDataDir,
    };
  }

  const dataHome = env.XDG_DATA_HOME ?? posix.join(homeDir, ".local", "share");
  const configHome = env.XDG_CONFIG_HOME ?? posix.join(homeDir, ".config");

  return {
    dataDir: posix.join(dataHome, LINUX_NAME),
    configDir: posix.join(configHome, LINUX_NAME),
  };
};

export const resolveExecutorPaths = (inputs: ExecutorPathInputs): ExecutorPaths => {
  const path = getPathModule(inputs.platform);
  const { dataDir, configDir } = resolveBaseDirs(inputs);
  const runtimeDataDir = inputs.env.EXECUTOR_DATA_DIR ?? dataDir;
  const legacyStateDir = path.join(inputs.homeDir, ".executor");

  return {
    dataDir: runtimeDataDir,
    configDir,
    runtimeDbPath: path.join(runtimeDataDir, "data.db"),
    desktopSettingsDir: configDir,
    desktopSettingsPath: path.join(configDir, "desktop-settings.json"),
    legacyStateDir,
    legacyRuntimeDbPath: path.join(legacyStateDir, "data.db"),
    legacyDesktopSettingsPath: path.join(legacyStateDir, "desktop-settings.json"),
    legacyCliBinDir: path.join(legacyStateDir, "bin"),
    legacyCliBinPath: path.join(
      legacyStateDir,
      "bin",
      inputs.platform === "win32" ? "executor.exe" : "executor",
    ),
  };
};

export const getExecutorPaths = (options: GetExecutorPathsOptions = {}): ExecutorPaths =>
  resolveExecutorPaths({
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    homeDir: options.homeDir ?? homedir(),
  });

export const copyLegacyFileIfMissing = ({
  legacyPath,
  targetPath,
  enabled = true,
  fs = defaultFileSystem,
}: CopyLegacyFileIfMissingOptions): LegacyFileCopyResult => {
  if (!enabled) return "skipped-disabled";
  if (fs.existsSync(targetPath)) return "skipped-existing-target";
  if (!fs.existsSync(legacyPath)) return "skipped-missing-legacy";

  fs.mkdirSync(dirname(targetPath), { recursive: true });
  fs.copyFileSync(legacyPath, targetPath);

  return "copied";
};
