import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PlankaClient } from "../client.js";
import { CARD_TYPES } from "../constants.js";
import { computePosition } from "../position.js";
import { id, positionSpec, safe } from "../util.js";

const W = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const summary = (c: any) => ({ id: c.id, name: c.name, listId: c.listId, boardId: c.boardId, position: c.position });
const isoDate = z.string().datetime({ offset: true }).describe("ISO 8601 date-time, e.g. 2026-12-01T12:00:00Z");

async function cardPositionsInList(client: PlankaClient, listId: string, excludeCardId?: string) {
  const list = await client.get(`/lists/${listId}`);
  const positions = (list.included?.cards ?? [])
    .filter((c: any) => c.id !== excludeCardId && c.listId === listId && typeof c.position === "number")
    .map((c: any) => c.position as number);
  return { list: list.item, positions };
}

export function registerCardTools(server: McpServer, client: PlankaClient) {
  server.registerTool(
    "planka_create_card",
    {
      title: "Create card",
      description: "Create a card in a list. Description supports Markdown.",
      inputSchema: {
        listId: id("List ID"),
        name: z.string().min(1).max(1024),
        description: z.string().min(1).optional(),
        dueDate: isoDate.optional(),
        type: z.enum(CARD_TYPES).optional().describe("Card type; defaults to the board's default card type"),
        position: positionSpec,
      },
      annotations: W,
    },
    safe(async ({ listId, name, description, dueDate, type, position }) => {
      const { list, positions } = await cardPositionsInList(client, listId);
      const cardType = type ?? (await client.get(`/boards/${list.boardId}`)).item.defaultCardType ?? "project";
      const body: Record<string, unknown> = { type: cardType, name, position: computePosition(positions, position) };
      if (description !== undefined) body.description = description;
      if (dueDate !== undefined) body.dueDate = dueDate;
      const { item } = await client.post(`/lists/${listId}/cards`, body);
      return summary(item);
    }),
  );

  server.registerTool(
    "planka_update_card",
    {
      title: "Update card",
      description:
        "Update card fields. Pass dueDate: null / description: null to clear them. " +
        "To close a card, move it to a list of type \"closed\" with planka_move_card.",
      inputSchema: {
        cardId: id("Card ID"),
        name: z.string().min(1).max(1024).optional(),
        description: z.string().min(1).nullable().optional(),
        dueDate: isoDate.nullable().optional(),
        isDueCompleted: z.boolean().optional(),
        type: z.enum(CARD_TYPES).optional(),
      },
      annotations: W,
    },
    safe(async ({ cardId, ...fields }) => {
      const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (!Object.keys(body).length) throw new Error("Nothing to update");
      const { item } = await client.patch(`/cards/${cardId}`, body);
      return { ...summary(item), description: item.description, dueDate: item.dueDate, isDueCompleted: item.isDueCompleted };
    }),
  );

  server.registerTool(
    "planka_move_card",
    {
      title: "Move card",
      description:
        "Move a card to another list (also across boards) or reorder it within its list. " +
        'Moving into a "closed"-type list closes the card.',
      inputSchema: {
        cardId: id("Card ID"),
        listId: id("Target list ID"),
        position: positionSpec,
      },
      annotations: W,
    },
    safe(async ({ cardId, listId, position }) => {
      const card = await client.get(`/cards/${cardId}`);
      const { list, positions } = await cardPositionsInList(client, listId, cardId);
      const body: Record<string, unknown> = { listId, position: computePosition(positions, position) };
      if (list.boardId !== card.item.boardId) body.boardId = list.boardId;
      const { item } = await client.patch(`/cards/${cardId}`, body);
      return { ...summary(item), isClosed: item.isClosed };
    }),
  );

  server.registerTool(
    "planka_delete_card",
    {
      title: "Delete card",
      description: "Permanently delete a card including its tasks and comments.",
      inputSchema: { cardId: id("Card ID") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ cardId }) => {
      const { item } = await client.delete(`/cards/${cardId}`);
      return { deleted: true, id: item?.id ?? cardId, name: item?.name };
    }),
  );
}
