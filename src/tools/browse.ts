import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PlankaClient } from "../client.js";
import { formatBoard, formatCard, formatProjects, searchBoard, type SearchHit } from "../format.js";
import { id, safe } from "../util.js";

const RO = { readOnlyHint: true, openWorldHint: true } as const;

export function registerBrowseTools(server: McpServer, client: PlankaClient) {
  server.registerTool(
    "planka_whoami",
    {
      title: "Who am I",
      description: "Return the Planka user the API key belongs to (id, name, role).",
      inputSchema: {},
      annotations: RO,
    },
    safe(async () => {
      const { item } = await client.get("/users/me");
      return { id: item.id, name: item.name, username: item.username, role: item.role, language: item.language };
    }),
  );

  server.registerTool(
    "planka_list_projects",
    {
      title: "List projects",
      description: "List all Planka projects visible to the user, each with its boards (id + name). Start here to find board IDs.",
      inputSchema: {},
      annotations: RO,
    },
    safe(async () => formatProjects(await client.get("/projects"))),
  );

  server.registerTool(
    "planka_get_board",
    {
      title: "Get board",
      description:
        "Get a board as lists → cards (with label names, task progress 'done/total', due date, comment count). " +
        "Also returns the board's labels and list IDs needed for creating/moving cards.",
      inputSchema: {
        boardId: id("Board ID"),
        includeArchived: z.boolean().optional().describe("Include archive/trash lists (default false)"),
        includeDescriptions: z.boolean().optional().describe("Include a short description preview per card (default false)"),
      },
      annotations: RO,
    },
    safe(async ({ boardId, includeArchived, includeDescriptions }) =>
      formatBoard(await client.get(`/boards/${boardId}`), { includeArchived, includeDescriptions }),
    ),
  );

  server.registerTool(
    "planka_get_card",
    {
      title: "Get card",
      description: "Get full card details: description, list, labels, due date, task lists with tasks (IDs), and comments.",
      inputSchema: { cardId: id("Card ID") },
      annotations: RO,
    },
    safe(async ({ cardId }) => {
      const card = await client.get(`/cards/${cardId}`);
      const [comments, board] = await Promise.all([
        client.get(`/cards/${cardId}/comments`),
        client.get(`/boards/${card.item.boardId}`),
      ]);
      return formatCard(card, comments, board);
    }),
  );

  server.registerTool(
    "planka_search_cards",
    {
      title: "Search cards",
      description:
        "Case-insensitive text search over card names and descriptions. Scope to a board or project; " +
        "with no scope, searches every board you can see.",
      inputSchema: {
        query: z.string().min(1).describe("Text to search for"),
        boardId: id("Board ID to search in").optional(),
        projectId: id("Project ID whose boards to search").optional(),
        includeArchived: z.boolean().optional().describe("Also search archive/trash lists (default false)"),
        limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)"),
      },
      annotations: RO,
    },
    safe(async ({ query, boardId, projectId, includeArchived, limit = 50 }) => {
      let boardIds: string[];
      if (boardId) boardIds = [boardId];
      else {
        const projects = await client.get("/projects");
        boardIds = (projects.included?.boards ?? [])
          .filter((b: any) => !projectId || b.projectId === projectId)
          .map((b: any) => b.id);
      }
      const hits: SearchHit[] = [];
      for (const bid of boardIds) {
        hits.push(...searchBoard(await client.get(`/boards/${bid}`), query, { includeArchived }));
        if (hits.length >= limit) break;
      }
      return { query, boardsSearched: boardIds.length, total: Math.min(hits.length, limit), results: hits.slice(0, limit) };
    }),
  );
}
