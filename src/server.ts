import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PlankaClient } from "./client.js";
import { registerAttachmentTools } from "./tools/attachments.js";
import { registerBrowseTools } from "./tools/browse.js";
import { registerCardTools } from "./tools/cards.js";
import { registerCommentTools } from "./tools/comments.js";
import { registerDeleteTools } from "./tools/delete.js";
import { registerLabelTools } from "./tools/labels.js";
import { registerListTools } from "./tools/lists.js";
import { registerMemberTools } from "./tools/members.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerUpdateTools } from "./tools/updates.js";
import { UpdateTracker } from "./updates.js";

export const SERVER_NAME = "mcp-planka";
export const SERVER_VERSION = "0.1.0";

export function createServer(
  client: PlankaClient,
  tracker = new UpdateTracker(client),
  opts: { managers?: string[]; instructions?: string; filesDir?: string } = {},
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    opts.instructions ? { instructions: opts.instructions } : undefined,
  );
  registerBrowseTools(server, client);
  registerProjectTools(server, client, opts.managers ?? []);
  registerListTools(server, client);
  registerCardTools(server, client);
  registerCommentTools(server, client);
  registerTaskTools(server, client);
  registerLabelTools(server, client);
  registerUpdateTools(server, tracker);
  registerMemberTools(server, client);
  registerDeleteTools(server, client);
  registerAttachmentTools(server, client, { filesDir: opts.filesDir });
  return server;
}
