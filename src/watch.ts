#!/usr/bin/env node
/**
 * Poll Planka and print one JSON line per event (new backlog card / new human comment).
 * Usage: mcp-planka-watch [--interval 60] [--project <id>] [--board <id> ...] [--once]
 * Designed to be followed by Claude Code's Monitor tool, or piped into any notifier.
 */
import { PlankaClient } from "./client.js";
import { loadConfig } from "./config.js";
import { defaultStatePath, UpdateTracker } from "./updates.js";

function parseArgs(argv: string[]) {
  const out = { interval: Number(process.env.PLANKA_WATCH_INTERVAL ?? 60), project: undefined as string | undefined, boards: [] as string[], once: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--interval") out.interval = Number(argv[++i]);
    else if (a === "--project") out.project = argv[++i];
    else if (a === "--board") out.boards.push(argv[++i]);
    else if (a === "--once") out.once = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!(out.interval >= 10)) throw new Error("--interval must be >= 10 seconds");
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  // Separate state from the MCP tool so the watcher and Claude don't consume each other's events.
  const tracker = new UpdateTracker(new PlankaClient(cfg.url, cfg.apiKey), defaultStatePath("watch-state.json"));
  const tick = async () => {
    try {
      const r = await tracker.check({ projectId: args.project, boardIds: args.boards });
      for (const b of r.boards) if (b.initialized) console.error(`baseline recorded for board ${b.name}`);
      for (const e of r.events) process.stdout.write(`${JSON.stringify(e)}\n`);
    } catch (err) {
      console.error(`check failed: ${err instanceof Error ? err.message : err}`);
    }
  };
  await tick();
  if (args.once) return;
  console.error(`watching every ${args.interval}s`);
  setInterval(tick, args.interval * 1000);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
