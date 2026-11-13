import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PlankaClient } from "../client.js";
import { id, safe } from "../util.js";

export interface MembershipChange {
  boardId: string;
  board: string;
  userId: string;
  user: string;
  role: string;
}

/**
 * Make every project manager of a project a member of each board in that project.
 * Planka lets project managers administer boards without being board members,
 * but only board members can comment, so managers are otherwise unable to comment.
 */
export async function syncBoardMembers(
  client: PlankaClient,
  projectId: string,
  opts: { role?: "editor" | "viewer"; dryRun?: boolean; boardIds?: string[] } = {},
) {
  const role = opts.role ?? "editor";
  const dryRun = opts.dryRun ?? true;
  const projects = await client.get("/projects");
  const inc = projects.included ?? {};
  if (!(projects.items ?? []).some((p: any) => p.id === projectId)) throw new Error(`Project ${projectId} not found`);
  const users = new Map<string, string>((inc.users ?? []).map((u: any) => [u.id, u.name ?? u.username ?? u.id]));
  const managers: string[] = (inc.projectManagers ?? [])
    .filter((m: any) => m.projectId === projectId)
    .map((m: any) => m.userId);
  const boards = (inc.boards ?? []).filter(
    (b: any) => b.projectId === projectId && (!opts.boardIds?.length || opts.boardIds.includes(b.id)),
  );

  const changes: MembershipChange[] = [];
  for (const b of boards) {
    const board = await client.get(`/boards/${b.id}`);
    const members = new Set((board.included?.boardMemberships ?? []).map((m: any) => m.userId));
    for (const userId of managers) {
      if (members.has(userId)) continue;
      if (!dryRun) await client.post(`/boards/${b.id}/board-memberships`, { userId, role });
      changes.push({ boardId: b.id, board: b.name, userId, user: users.get(userId) ?? userId, role });
    }
  }
  return { projectId, dryRun, managers: managers.length, boardsChecked: boards.length, [dryRun ? "wouldAdd" : "added"]: changes };
}

export function registerMemberTools(server: McpServer, client: PlankaClient) {
  server.registerTool(
    "planka_sync_board_members",
    {
      title: "Sync project managers to boards",
      description:
        "Add every project manager of a project as a member (editor by default) of each board in that project " +
        "they are not yet a member of — needed so they can comment. CHANGES ACCESS: defaults to dryRun=true; " +
        "show the user the planned changes and only call with dryRun=false after they confirm.",
      inputSchema: {
        projectId: id("Project ID"),
        role: z.enum(["editor", "viewer"]).optional().describe('Board role to grant (default "editor")'),
        boardIds: z.array(id("Board ID")).optional().describe("Limit to these boards"),
        dryRun: z.boolean().optional().describe("Only report what would change (default true)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ projectId, role, boardIds, dryRun }) => syncBoardMembers(client, projectId, { role, boardIds, dryRun })),
  );
}
