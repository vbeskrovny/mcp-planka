#!/usr/bin/env node
/** Connection check used by register.sh: prints the Planka host and API-key user, exits 1 on failure. */
import { PlankaClient } from "./client.js";
import { loadConfig } from "./config.js";

try {
  const cfg = loadConfig();
  const me = (await new PlankaClient(cfg.url, cfg.apiKey).get("/users/me")).item;
  const managers = cfg.managers.length ? `, MANAGERS: ${cfg.managers.join(", ")}` : "";
  console.log(`OK: ${new URL(cfg.url).host} as ${me.name || me.username || me.id} (${me.role})${managers}`);
} catch (err) {
  console.error(`FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
