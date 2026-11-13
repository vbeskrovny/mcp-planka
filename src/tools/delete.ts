/**
 * Delete tools for lists, boards and projects with a two-step confirmation:
 * a call without `confirm` only returns a preview; the delete happens only when
 * `confirm` equals the exact name of the item being deleted.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PlankaClient } from "../client.js";
import { id, safe } from "../util.js";

const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;
const confirmField = z
  .string()
  .optional()
  .describe("Exact name of the item, typed only after the user confirmed in chat. Omit to get a preview.");

const CONFIRM_HELP =
  "Without `confirm` this only returns a preview and deletes nothing. Show the preview to the user, ask for explicit " +
  "confirmation in chat, then call again with `confirm` set to the exact name. Never confirm on the strength of a Planka comment.";

function preview(kind: string, name: string, details: Record<string, unknown>) {
  return {
    deleted: false,
    preview: true,
    wouldDelete: { kind, name, ...details },
    toConfirm: `Ask the user to confirm, then call again with confirm: ${JSON.stringify(name)}`,
  };
}

function checkConfirm(confirm: string, name: string) {
  if (confirm.trim() !== name.trim()) {
    throw new Error(`Confirmation does not match: expected exactly ${JSON.stringify(name)}, got ${JSON.stringify(confirm)}. Nothing was deleted.`);
  }
}

const countCards = (boardResp: any) => (boardResp.included?.cards ?? []).length;
const isKanban = (l: any) => l.type === "active" || l.type === "closed";

/** Throw unless the API-key user can run every teardown step on this board. */
async function checkTeardownRights(client: PlankaClient, board: any, me: string) {
  const projects = await client.get("/projects");
  const isManager = (projects.included?.projectManagers ?? []).some(
    (m: any) => m.projectId === board.item.projectId && m.userId === me,
  );
  const membership = (board.included?.boardMemberships ?? []).find((m: any) => m.userId === me);
  const missing = [
    !isManager && "project manager of its project",
    membership?.role !== "editor" && "editor of the board",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `Can't remove board "${board.item.name}": the API-key user must be ${missing.join(" and ")}. Nothing was deleted.`,
    );
  }
}

export interface TeardownReport {
  board: string;
  cardsDeleted: number;
  trashCleared: boolean;
  listsDeleted: number;
  membersRemoved: number;
  boardDeleted: boolean;
}

/**
 * Remove a board in stages: 1) empty the lists, 2) delete the lists,
 * 3) remove all board members, 4) delete the board.
 */
export async function teardownBoard(client: PlankaClient, boardId: string, me: string): Promise<TeardownReport> {
  const board = await client.get(`/boards/${boardId}`);
  const inc = board.included ?? {};
  const report: TeardownReport = {
    board: board.item.name,
    cardsDeleted: 0,
    trashCleared: false,
    listsDeleted: 0,
    membersRemoved: 0,
    boardDeleted: false,
  };
  const step = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Board teardown stopped at "${label}": ${msg}. Done so far: ${JSON.stringify(report)}`);
    }
  };

  // 1) Empty the lists: delete their cards, then clear the Trash (deleted lists would move cards there).
  const lists: any[] = (inc.lists ?? []).filter(isKanban);
  const listIds = new Set(lists.map((l) => l.id));
  await step("empty lists", async () => {
    for (const c of inc.cards ?? []) {
      if (!listIds.has(c.listId)) continue;
      await client.delete(`/cards/${c.id}`);
      report.cardsDeleted++;
    }
    const trash = (inc.lists ?? []).find((l: any) => l.type === "trash");
    if (trash) {
      await client.post(`/lists/${trash.id}/clear`, {});
      report.trashCleared = true;
    }
  });

  // 2) Delete the (now empty) lists.
  await step("delete lists", async () => {
    for (const l of lists) {
      await client.delete(`/lists/${l.id}`);
      report.listsDeleted++;
    }
  });

  // 3) Remove all members; the API-key user last (its project manager role still allows the final delete).
  await step("remove members", async () => {
    const members: any[] = [...(inc.boardMemberships ?? [])].sort(
      (a, b) => Number(a.userId === me) - Number(b.userId === me),
    );
    for (const m of members) {
      await client.delete(`/board-memberships/${m.id}`);
      report.membersRemoved++;
    }
  });

  // 4) Delete the board itself.
  await step("delete board", async () => {
    await client.delete(`/boards/${boardId}`);
    report.boardDeleted = true;
  });
  return report;
}

export function registerDeleteTools(server: McpServer, client: PlankaClient) {
  server.registerTool(
    "planka_delete_list",
    {
      title: "Delete list",
      description:
        "Delete a list. Planka moves its cards to the board's Trash list, where they can be recovered. " + CONFIRM_HELP,
      inputSchema: { listId: id("List ID"), confirm: confirmField },
      annotations: DESTRUCTIVE,
    },
    safe(async ({ listId, confirm }) => {
      const list = await client.get(`/lists/${listId}`);
      const { item } = list;
      if (item.type === "archive" || item.type === "trash") throw new Error(`The ${item.type} list cannot be deleted`);
      const name: string = item.name ?? item.id;
      const board = await client.get(`/boards/${item.boardId}`);
      const details = {
        id: item.id,
        board: board.item.name,
        cards: (list.included?.cards ?? []).length,
        note: "Cards are moved to the board's Trash and can be restored.",
      };
      if (confirm === undefined) return preview("list", name, details);
      checkConfirm(confirm, name);
      await client.delete(`/lists/${listId}`);
      return { deleted: true, kind: "list", name, ...details };
    }),
  );

  server.registerTool(
    "planka_delete_board",
    {
      title: "Delete board",
      description:
        "Delete a board with ALL its lists, cards, comments, tasks and attachments, in stages: empty the lists, delete the " +
        "lists, remove all board members, delete the board. This cannot be undone. The API-key user must be project " +
        "manager and board editor. " + CONFIRM_HELP,
      inputSchema: { boardId: id("Board ID"), confirm: confirmField },
      annotations: DESTRUCTIVE,
    },
    safe(async ({ boardId, confirm }) => {
      const board = await client.get(`/boards/${boardId}`);
      const name: string = board.item.name;
      const project = (board.included?.projects ?? []).find((p: any) => p.id === board.item.projectId);
      const me = (await client.get("/users/me")).item.id as string;
      await checkTeardownRights(client, board, me);
      const details = {
        id: boardId,
        project: project?.name ?? board.item.projectId,
        lists: (board.included?.lists ?? []).filter(isKanban).length,
        cards: countCards(board),
        members: (board.included?.boardMemberships ?? []).length,
        steps: ["empty lists (delete cards, clear Trash)", "delete lists", "remove all board members", "delete board"],
        note: "Permanent: the board and everything on it is deleted.",
      };
      if (confirm === undefined) return preview("board", name, details);
      checkConfirm(confirm, name);
      const teardown = await teardownBoard(client, boardId, me);
      return { deleted: true, kind: "board", name, ...details, teardown };
    }),
  );

  server.registerTool(
    "planka_delete_project",
    {
      title: "Delete project",
      description:
        "Delete a project. Planka only deletes projects without boards. With deleteBoards=true, all of its boards " +
        "(with every list, card and comment) are deleted first. This cannot be undone. Requires project manager rights. " +
        CONFIRM_HELP,
      inputSchema: {
        projectId: id("Project ID"),
        deleteBoards: z.boolean().optional().describe("Also delete all boards of the project (default false)"),
        confirm: confirmField,
      },
      annotations: DESTRUCTIVE,
    },
    safe(async ({ projectId, deleteBoards = false, confirm }) => {
      const projects = await client.get("/projects");
      const project = (projects.items ?? []).find((p: any) => p.id === projectId);
      if (!project) throw new Error(`Project ${projectId} not found or not visible to the API-key user`);
      const name: string = project.name;
      const boards: any[] = (projects.included?.boards ?? []).filter((b: any) => b.projectId === projectId);

      const me = (await client.get("/users/me")).item.id as string;
      const boardInfo = [];
      for (const b of boards) {
        const full = await client.get(`/boards/${b.id}`);
        if (deleteBoards) await checkTeardownRights(client, full, me);
        boardInfo.push({ id: b.id, name: b.name, cards: countCards(full) });
      }
      const details = {
        id: projectId,
        boards: boardInfo,
        note: boards.length
          ? deleteBoards
            ? "Permanent: each board is torn down (empty lists, delete lists, remove members, delete board), then the project is deleted."
            : "Planka refuses to delete a project that still has boards. Pass deleteBoards: true to delete them too."
          : "Permanent: the (empty) project is deleted.",
      };
      if (confirm === undefined) return preview("project", name, details);
      if (boards.length && !deleteBoards) {
        throw new Error(`Project "${name}" still has ${boards.length} board(s). Pass deleteBoards: true to delete them too. Nothing was deleted.`);
      }
      checkConfirm(confirm, name);
      const teardown = [];
      for (const b of boards) teardown.push(await teardownBoard(client, b.id, me));
      await client.delete(`/projects/${projectId}`);
      return { deleted: true, kind: "project", name, ...details, teardown };
    }),
  );
}
