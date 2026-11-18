import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

/** Settings the server reads, all with the PLANKA_ prefix (same names in the environment and in .env). */
export const CONFIG_KEYS = ["PLANKA_URL", "PLANKA_API_KEY", "PLANKA_MANAGERS", "PLANKA_INSTRUCTIONS", "PLANKA_FILES_DIR"] as const;
/** Keys of the old .planka format, and their new names. */
export const LEGACY_KEYS: Record<string, string> = {
  URL: "PLANKA_URL",
  KEY: "PLANKA_API_KEY",
  MANAGERS: "PLANKA_MANAGERS",
  INSTRUCTIONS: "PLANKA_INSTRUCTIONS",
  FILES_DIR: "PLANKA_FILES_DIR",
};

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** Candidate paths for the config file, checked in order. */
  files?: string[];
}

/**
 * Resolve config: PLANKA_* env vars win, otherwise the same keys from a `.env` file:
 * $PLANKA_CONFIG, else `.env` in the package root. The current directory is NOT searched:
 * it is usually the project the client works on, whose own .env has nothing to do with Planka.
 */
export function loadConfig(opts: LoadConfigOptions = {}): PlankaConfig {
  const env = opts.env ?? process.env;
  const files = opts.files ?? (env.PLANKA_CONFIG ? [env.PLANKA_CONFIG] : [resolve(packageRoot, ".env")]);

  let fileValues: Record<string, string> = {};
  let source: string | undefined;
  for (const f of files) {
    if (existsSync(f)) {
      fileValues = parseKeyValue(readFileSync(f, "utf8"));
      source = f;
      break;
    }
  }
  const get = (k: (typeof CONFIG_KEYS)[number]) => env[k] || fileValues[k] || undefined;

  const url = get("PLANKA_URL");
  const apiKey = get("PLANKA_API_KEY");
  const missing = [!url && "PLANKA_URL", !apiKey && "PLANKA_API_KEY"].filter(Boolean);
  if (missing.length) {
    const legacy = Object.keys(LEGACY_KEYS).filter((k) => k in fileValues);
    const legacyFile = files.map((f) => resolve(dirname(f), ".planka")).find((f) => existsSync(f));
    const hint = legacy.length
      ? ` ${source} uses old key names (${legacy.join(", ")}); rename them to ${legacy.map((k) => LEGACY_KEYS[k]).join(", ")} or run ./register.sh, which migrates them.`
      : legacyFile
        ? ` Found the old config ${legacyFile}: run ./register.sh to migrate it to .env.`
        : "";
    throw new ConfigError(
      `Missing Planka config: ${missing.join(", ")}. Set them as environment variables or in a .env file ` +
        `(PLANKA_URL=..., PLANKA_API_KEY=...).${hint}`,
    );
  }
  const managers = (get("PLANKA_MANAGERS") ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  // INSTRUCTIONS may be set to an empty value on purpose (= default), so don't treat "" as unset.
  const instructions = env.PLANKA_INSTRUCTIONS ?? fileValues.PLANKA_INSTRUCTIONS;
  const filesDir = get("PLANKA_FILES_DIR");
  return {
    url: url!.replace(/\/+$/, ""),
    apiKey: apiKey!,
    managers,
    ...(instructions !== undefined ? { instructions } : {}),
    ...(filesDir ? { filesDir } : {}),
  };
}
