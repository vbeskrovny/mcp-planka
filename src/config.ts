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

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** Candidate paths for the .planka file, checked in order. */
  files?: string[];
}

/**
 * Resolve config: PLANKA_URL / PLANKA_API_KEY env vars win, otherwise a `.planka`
 * file (PLANKA_CONFIG, then the current directory, then the package root).
 */
export function loadConfig(opts: LoadConfigOptions = {}): PlankaConfig {
  const env = opts.env ?? process.env;
  const files = opts.files ?? [
    ...(env.PLANKA_CONFIG ? [env.PLANKA_CONFIG] : []),
    resolve(process.cwd(), ".planka"),
    resolve(packageRoot, ".planka"),
  ];

  let fileValues: Record<string, string> = {};
  for (const f of files) {
    if (existsSync(f)) {
      fileValues = parseKeyValue(readFileSync(f, "utf8"));
      break;
    }
  }

  const url = env.PLANKA_URL || fileValues.URL || fileValues.PLANKA_URL;
  const apiKey = env.PLANKA_API_KEY || fileValues.KEY || fileValues.PLANKA_API_KEY;

  const missing = [!url && "URL (PLANKA_URL)", !apiKey && "KEY (PLANKA_API_KEY)"].filter(Boolean);
  if (missing.length) {
    throw new ConfigError(
      `Missing Planka config: ${missing.join(", ")}. Set env vars or create a .planka file with URL=... and KEY=...`,
    );
  }
  const managers = (env.PLANKA_MANAGERS ?? fileValues.MANAGERS ?? fileValues.PLANKA_MANAGERS ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const instructions = env.PLANKA_INSTRUCTIONS ?? fileValues.INSTRUCTIONS ?? fileValues.PLANKA_INSTRUCTIONS;
  return { url: url!.replace(/\/+$/, ""), apiKey: apiKey!, managers, ...(instructions !== undefined ? { instructions } : {}) };
}
