import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface PlankaConfig {
  url: string;
  apiKey: string;
  /** Users (id, username, email or name) added as managers to every project the MCP creates. */
  managers: string[];
  /** INSTRUCTIONS setting: unset = built-in workflow rules, "off" = none, otherwise a file path. */
  instructions?: string;
  /** If set, attachment tools only read/write local files inside this directory. */
  filesDir?: string;
  /** Where update-tracking snapshots are kept (default ~/.mcp-planka). */
  stateDir?: string;
  /** Regex (case-insensitive) marking backlog lists (default "backlog"). */
  backlogPattern?: string;
  /** Label that asks to start a card now (default "START"). */
  startLabel?: string;
  /** Default poll interval of the watcher, in seconds. */
  watchInterval?: number;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Parse a KEY=VALUE file. Tolerates CRLF, blank lines, `#` comments and `=` inside values. */
export function parseKeyValue(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\r/g, "").trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Prefix of every mcp-planka setting, in the environment and in .env. */
export const PREFIX = "MCP_APP_PLANKA_";
/** Setting names (without the prefix). */
export const SETTINGS = [
  "URL", "API_KEY", "MANAGERS", "INSTRUCTIONS", "FILES_DIR", "STATE_DIR", "BACKLOG_PATTERN", "START_LABEL", "WATCH_INTERVAL",
] as const;
export type Setting = (typeof SETTINGS)[number];
/** Environment variable with the config file path (it can't be set inside that file). */
export const CONFIG_PATH_VAR = `${PREFIX}CONFIG`;

/** Old names and their new ones: PLANKA_<name> (.env, 2026-11) and the bare .planka keys before that. */
export const LEGACY_KEYS: Record<string, string> = {
  URL: `${PREFIX}URL`,
  KEY: `${PREFIX}API_KEY`,
  MANAGERS: `${PREFIX}MANAGERS`,
  INSTRUCTIONS: `${PREFIX}INSTRUCTIONS`,
  FILES_DIR: `${PREFIX}FILES_DIR`,
  PLANKA_CONFIG: CONFIG_PATH_VAR,
  ...Object.fromEntries(SETTINGS.map((k) => [`PLANKA_${k}`, `${PREFIX}${k}`])),
};

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** Candidate paths for the config file, checked in order. */
  files?: string[];
}

/**
 * Resolve config: MCP_APP_PLANKA_* environment variables win, otherwise the same keys from a `.env` file:
 * $MCP_APP_PLANKA_CONFIG, else `.env` in the package root. The current directory is NOT searched:
 * it is usually the project the client works on, whose own .env has nothing to do with Planka.
 */
export function loadConfig(opts: LoadConfigOptions = {}): PlankaConfig {
  const env = opts.env ?? process.env;
  const files = opts.files ?? (env[CONFIG_PATH_VAR] ? [env[CONFIG_PATH_VAR]!] : [resolve(packageRoot, ".env")]);

  let fileValues: Record<string, string> = {};
  let source: string | undefined;
  for (const f of files) {
    if (existsSync(f)) {
      fileValues = parseKeyValue(readFileSync(f, "utf8"));
      source = f;
      break;
    }
  }
  /** A setting: environment first, then the file; empty counts as unset. */
  const get = (k: Setting) => env[PREFIX + k] || fileValues[PREFIX + k] || undefined;

  const url = get("URL");
  const apiKey = get("API_KEY");
  const missing = [!url && `${PREFIX}URL`, !apiKey && `${PREFIX}API_KEY`].filter(Boolean);
  if (missing.length) {
    // Bare keys (URL, KEY, ...) only count as ours in a .planka* file; a shared .env may use them for another app.
    const bareOk = !!source && basename(source).startsWith(".planka");
    const inFile = Object.keys(LEGACY_KEYS).filter((k) => k in fileValues && (k.startsWith("PLANKA_") || bareOk));
    const inEnv = Object.keys(LEGACY_KEYS).filter((k) => k.startsWith("PLANKA_") && env[k] !== undefined);
    const legacyFile = files.map((f) => resolve(dirname(f), ".planka")).find((f) => existsSync(f));
    const rename = (keys: string[]) => keys.map((k) => `${k} -> ${LEGACY_KEYS[k]}`).join(", ");
    const hints = [
      inFile.length && `${source} uses old key names (${rename(inFile)}); run ./register.sh, which migrates them, or rename them by hand.`,
      inEnv.length && `Old environment variable names are set (${rename(inEnv)}); rename them.`,
      !inFile.length && legacyFile && `Found the old config ${legacyFile}: run ./register.sh to migrate it to .env.`,
    ].filter(Boolean);
    throw new ConfigError(
      `Missing Planka config: ${missing.join(", ")}. Set them as environment variables or in a .env file ` +
        `(${PREFIX}URL=..., ${PREFIX}API_KEY=...).${hints.length ? ` ${hints.join(" ")}` : ""}`,
    );
  }
  const managers = (get("MANAGERS") ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  // INSTRUCTIONS may be set to an empty value on purpose (= default), so don't treat "" as unset.
  const instructions = env[`${PREFIX}INSTRUCTIONS`] ?? fileValues[`${PREFIX}INSTRUCTIONS`];
  const interval = get("WATCH_INTERVAL");
  const watchInterval = interval === undefined ? undefined : Number(interval);
  if (watchInterval !== undefined && !(watchInterval >= 10)) {
    throw new ConfigError(`${PREFIX}WATCH_INTERVAL must be a number of seconds >= 10`);
  }
  const optional = {
    filesDir: get("FILES_DIR"),
    stateDir: get("STATE_DIR"),
    backlogPattern: get("BACKLOG_PATTERN"),
    startLabel: get("START_LABEL"),
    watchInterval,
  };
  return {
    url: url!.replace(/\/+$/, ""),
    apiKey: apiKey!,
    managers,
    ...(instructions !== undefined ? { instructions } : {}),
    ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)),
  };
}
