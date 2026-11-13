import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PlankaClient } from "../client.js";
import { id, safe } from "../util.js";

const W = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const fmt = (c: any) => ({ id: c.id, cardId: c.cardId, text: c.text, createdAt: c.createdAt });

export function registerCommentTools(server: McpServer, client: PlankaClient) {
  server.registerTool(
    "planka_add_comment",
    {
      title: "Add comment",
      description: "Post a comment on a card (Markdown supported). Use this to reply to people on a card.",
      inputSchema: { cardId: id("Card ID"), text: z.string().min(1) },
      annotations: W,
    },
    safe(async ({ cardId, text }) => fmt((await client.post(`/cards/${cardId}/comments`, { text })).item)),
  );

  server.registerTool(
    "planka_update_comment",
    {
      title: "Update comment",
      description: "Edit the text of a comment (only your own comments, unless you are a board admin).",
      inputSchema: { commentId: id("Comment ID"), text: z.string().min(1) },
      annotations: W,
    },
    safe(async ({ commentId, text }) => fmt((await client.patch(`/comments/${commentId}`, { text })).item)),
  );

  server.registerTool(
    "planka_delete_comment",
    {
      title: "Delete comment",
      description: "Delete a comment.",
      inputSchema: { commentId: id("Comment ID") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ commentId }) => {
      await client.delete(`/comments/${commentId}`);
      return { deleted: true, id: commentId };
    }),
  );
}
