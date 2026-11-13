import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PlankaClient } from "../client.js";
import { LABEL_COLORS } from "../constants.js";
import { computePosition } from "../position.js";
import { id, safe } from "../util.js";

const W = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

export function registerLabelTools(server: McpServer, client: PlankaClient) {
  server.registerTool(
    "planka_create_label",
    {
      title: "Create label",
      description: "Create a label on a board. Use planka_get_board first to reuse existing labels.",
      inputSchema: {
        boardId: id("Board ID"),
        name: z.string().min(1).max(128),
        color: z.enum(LABEL_COLORS).describe("Planka color name, e.g. berry-red, lagoon-blue, sunny-grass"),
      },
      annotations: W,
    },
    safe(async ({ boardId, name, color }) => {
      const board = await client.get(`/boards/${boardId}`);
      const existing = (board.included?.labels ?? []).map((l: any) => l.position as number);
      const { item } = await client.post(`/boards/${boardId}/labels`, { name, color, position: computePosition(existing) });
      return { id: item.id, name: item.name, color: item.color, boardId: item.boardId };
    }),
  );

  server.registerTool(
    "planka_add_label_to_card",
    {
      title: "Add label to card",
      description: "Attach an existing board label to a card.",
      inputSchema: { cardId: id("Card ID"), labelId: id("Label ID") },
      annotations: { ...W, idempotentHint: true },
    },
    safe(async ({ cardId, labelId }) => {
      const { item } = await client.post(`/cards/${cardId}/card-labels`, { labelId });
      return { cardId: item.cardId, labelId: item.labelId };
    }),
  );

  server.registerTool(
    "planka_remove_label_from_card",
    {
      title: "Remove label from card",
      description: "Detach a label from a card (the label itself stays on the board).",
      inputSchema: { cardId: id("Card ID"), labelId: id("Label ID") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ cardId, labelId }) => {
      await client.delete(`/cards/${cardId}/card-labels/labelId:${labelId}`);
      return { removed: true, cardId, labelId };
    }),
  );
}
