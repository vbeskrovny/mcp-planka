#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PlankaClient } from "./client.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

async function main() {
  const config = loadConfig();
  const client = new PlankaClient(config.url, config.apiKey);
  const server = createServer(client, undefined, { managers: config.managers });
  await server.connect(new StdioServerTransport());
  console.error(`mcp-planka connected to ${new URL(config.url).host}`);
}

main().catch((err) => {
  console.error(`mcp-planka failed to start: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
