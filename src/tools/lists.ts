import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PlankaClient } from "../client.js";
import { KANBAN_LIST_TYPES } from "../constants.js";
import { computePosition } from "../position.js";
import { id, positionSpec, safe } from "../util.js";

const W = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const kanbanPositions = (lists: any[], excludeId?: string) =>
  lists.filter((l) => l.id !== excludeId && typeof l.position === "number").map((l) => l.position as number);

export function registerListTools(server: McpServer, client: PlankaClient) {
  server.registerTool(
    "planka_create_list",
    {
      title: "Create list",
      description: 'Create a list (column) on a board. Use type "closed" for a done-style list whose cards count as closed.',
      inputSchema: {
        boardId: id("Board ID"),
        name: z.string().min(1).max(128),
        type: z.enum(KANBAN_LIST_TYPES).optional().describe('"active" (default) or "closed"'),
        position: positionSpec,
      },
      annotations: W,
    },
    safe(async ({ boardId, name, type = "active", position }) => {
      const board = await client.get(`/boards/${boardId}`);
      const pos = computePosition(kanbanPositions(board.included?.lists ?? []), position);
      const { item } = await client.post(`/boards/${boardId}/lists`, { type, name, position: pos });
      return { id: item.id, name: item.name, type: item.type, boardId: item.boardId };
    }),
  );

  server.registerTool(
    "planka_update_list",
    {
      title: "Update list",
      description: "Rename a list, change its type (active/closed) or reorder it on the board.",
      inputSchema: {
        listId: id("List ID"),
        name: z.string().min(1).max(128).optional(),
        type: z.enum(KANBAN_LIST_TYPES).optional(),
        position: positionSpec,
      },
      annotations: W,
    },
    safe(async ({ listId, name, type, position }) => {
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (type !== undefined) body.type = type;
      if (position !== undefined) {
        const list = await client.get(`/lists/${listId}`);
        const board = await client.get(`/boards/${list.item.boardId}`);
        body.position = computePosition(kanbanPositions(board.included?.lists ?? [], listId), position);
      }
      if (!Object.keys(body).length) throw new Error("Nothing to update: pass name, type or position");
      const { item } = await client.patch(`/lists/${listId}`, body);
      return { id: item.id, name: item.name, type: item.type, position: item.position };
    }),
  );

  server.registerTool(
    "planka_move_list",
    {
      title: "Move list",
      description:
        "Move a list with all its cards to another board, which can also be in another project. " +
        "The API-key user must be an editor on both boards. Side effects on the moved cards: labels are re-created by name " +
        "on the target board, card members and task assignees who are not members of the target board are removed, and " +
        "custom fields are detached. Use planka_update_list to reorder a list within its own board.",
      inputSchema: {
        listId: id("List ID"),
        boardId: id("Target board ID"),
        position: positionSpec,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe(async ({ listId, boardId, position }) => {
      const list = await client.get(`/lists/${listId}`);
      const fromBoardId: string = list.item.boardId;
      if (fromBoardId === boardId) {
        throw new Error("The list is already on that board. Use planka_update_list to reorder it.");
      }
      if (list.item.type && !KANBAN_LIST_TYPES.includes(list.item.type)) {
        throw new Error(`Only active/closed lists can be moved (this list is "${list.item.type}")`);
      }

      const me = (await client.get("/users/me")).item.id as string;
      let target: any;
      try {
        target = await client.get(`/boards/${boardId}`);
      } catch {
        throw new Error(
          `Target board ${boardId} not found or not accessible to the API-key user. It must be a board member (editor).`,
        );
      }
      const membership = (target.included?.boardMemberships ?? []).find((m: any) => m.userId === me);
      if (membership?.role !== "editor") {
        throw new Error(
          `The API-key user is ${membership ? `a ${membership.role}` : "not a member"} of target board "${target.item.name}"; ` +
            "editor rights are required. Add it as an editor on that board first.",
        );
      }

      const pos = computePosition(kanbanPositions(target.included?.lists ?? []), position);
      const { item } = await client.patch(`/lists/${listId}`, { boardId, position: pos });
      const project = (target.included?.projects ?? []).find((p: any) => p.id === target.item.projectId);
      return {
        id: item.id,
        name: item.name,
        type: item.type,
        fromBoardId,
        board: { id: target.item.id, name: target.item.name },
        project: project ? { id: project.id, name: project.name } : { id: target.item.projectId },
        cardsMoved: (list.included?.cards ?? []).length,
        position: item.position,
      };
    }),
  );
}
