#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PlankaClient } from "./client.js";
import { loadConfig } from "./config.js";
import { resolveInstructions } from "./instructions.js";
import { createServer } from "./server.js";
import { trackerFromConfig } from "./updates.js";

async function main() {
  const config = loadConfig();
  const client = new PlankaClient(config.url, config.apiKey);
  const instructions = resolveInstructions(config.instructions);
  const server = createServer(client, trackerFromConfig(client, config), {
    managers: config.managers,
    instructions,
    filesDir: config.filesDir,
  });
  await server.connect(new StdioServerTransport());
  console.error(`mcp-planka connected to ${new URL(config.url).host}`);
}

main().catch((err) => {
  console.error(`mcp-planka failed to start: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
