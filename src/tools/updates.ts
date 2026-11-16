import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { UpdateTracker } from "../updates.js";
import { id, safe } from "../util.js";

export function registerUpdateTools(server: McpServer, tracker: UpdateTracker) {
  server.registerTool(
    "planka_check_updates",
    {
      title: "Check for updates",
      description:
        "Notifications since the last check: new cards in Backlog lists (created or moved in), cards moved to " +
        "another list (card_moved, with from/to list and who moved it), tasks ticked or unticked (task, completed " +
        "true/false), cards labelled START (start_request: start work on it now, then remove that labelId), and new " +
        "comments written by people other than you. Your own changes are not reported. The first check of a board only records a baseline. " +
        "Reply to a comment with planka_add_comment on the same cardId to talk back on the card.",
      inputSchema: {
        projectId: id("Only check boards of this project").optional(),
        boardIds: z.array(id("Board ID")).optional().describe("Only check these boards"),
        peek: z.boolean().optional().describe("Report without marking events as seen (default false)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ projectId, boardIds, peek }) => tracker.check({ projectId, boardIds, peek })),
  );
}
