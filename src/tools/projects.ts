import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PlankaClient } from "../client.js";
import { POSITION_GAP } from "../position.js";
import { id, safe } from "../util.js";
import { syncBoardMembers, type MembershipChange } from "./members.js";

export const DEFAULT_LISTS = ["Backlog", "In Progress", "Testing", "Done"];
const W = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const norm = (s: string) => s.trim().toLowerCase();

/** Case-insensitive exact name match (e.g. folder "mcp-planka" ↔ project "MCP-PLANKA"). */
export async function findProject(client: PlankaClient, name: string) {
  const resp = await client.get("/projects");
  const matches = (resp.items ?? []).filter((p: any) => norm(p.name) === norm(name));
  const boards = resp.included?.boards ?? [];
  return matches.map((p: any) => ({
    id: p.id,
    name: p.name,
    boards: boards
      .filter((b: any) => b.projectId === p.id)
      .sort((a: any, b: any) => a.position - b.position)
      .map((b: any) => ({ id: b.id, name: b.name })),
  }));
}

export async function createBoard(
  client: PlankaClient,
  projectId: string,
  name: string,
  lists: string[],
  opts: { addProjectManagers?: boolean; editors?: { id: string; label: string }[] } = {},
) {
  const existing = (await client.get("/projects")).included?.boards?.filter((b: any) => b.projectId === projectId) ?? [];
  const position = Math.max(0, ...existing.map((b: any) => b.position ?? 0)) + POSITION_GAP;
  const { item: board } = await client.post(`/projects/${projectId}/boards`, { name, position });
  const created = [];
  for (let i = 0; i < lists.length; i++) {
    const { item } = await client.post(`/boards/${board.id}/lists`, {
      type: "active",
      name: lists[i],
      position: (i + 1) * POSITION_GAP,
    });
    created.push({ id: item.id, name: item.name });
  }
  // Planka only makes the creator a board member; other people can't comment until added.
  const addedEditors: string[] = [];
  for (const u of opts.editors ?? []) {
    await client.post(`/boards/${board.id}/board-memberships`, { userId: u.id, role: "editor" });
    addedEditors.push(u.label);
  }
  let addedMembers: MembershipChange[] | undefined;
  if (opts.addProjectManagers) {
    const r: any = await syncBoardMembers(client, projectId, { dryRun: false, role: "editor", boardIds: [board.id] });
    addedMembers = r.added;
  }
  return {
    id: board.id,
    name: board.name,
    projectId,
    lists: created,
    ...(addedEditors.length ? { editors: addedEditors } : {}),
    ...(addedMembers ? { addedMembers } : {}),
  };
}

/** Resolve user references (id, username, email or name; case-insensitive) to Planka users. */
export async function resolveUsers(client: PlankaClient, refs: string[]) {
  const me = (await client.get("/users/me")).item.id as string;
  const all: any[] = (await client.get("/users")).items ?? [];
  const out: { id: string; label: string }[] = [];
  for (const ref of refs) {
    const r = norm(ref);
    const u = all.find((x) => x.id === ref || [x.username, x.email, x.name].some((v) => v && norm(v) === r));
    if (!u) throw new Error(`Manager "${ref}" not found among Planka users. Nothing was created.`);
    if (u.id !== me && !out.some((o) => o.id === u.id)) out.push({ id: u.id, label: u.name ?? u.username ?? u.id });
  }
  return out;
}

export function registerProjectTools(server: McpServer, client: PlankaClient, defaultManagers: string[] = []) {
  server.registerTool(
    "planka_find_project",
    {
      title: "Find project by name",
      description:
        "Find Planka projects whose name equals the given name (case-insensitive), with their boards. " +
        "Use it to map a code folder/repo name to its Planka project. Returns an empty list if none exists.",
      inputSchema: { name: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ name }) => ({ query: name, matches: await findProject(client, name) })),
  );

  server.registerTool(
    "planka_create_project",
    {
      title: "Create project",
      description:
        "Create a PRIVATE Planka project (only its board members can see it; there is no shared option), named in " +
        "UPPERCASE (\"mcp-planka\" becomes \"MCP-PLANKA\"), by default " +
        "with a board 'Development' and lists Backlog / In Progress / Testing / Done. Only call when the user explicitly " +
        "asks. The users from the MANAGERS config are added automatically as editors of the new board, so they can see " +
        "and work on it. Nothing else is needed for them to get access.",
      inputSchema: {
        name: z.string().min(1).max(128),
        description: z.string().min(1).max(1024).optional(),
        board: z.string().min(1).max(128).nullable().optional().describe('First board name (default "Development"; null = no board)'),
        lists: z.array(z.string().min(1).max(128)).optional().describe("Lists for the board (default Backlog, In Progress, Testing, Done)"),
      },
      annotations: W,
    },
    safe(async ({ name: rawName, description, board = "Development", lists = DEFAULT_LISTS }) => {
      // Project names are always UPPERCASE (folder "mcp-planka" -> project "MCP-PLANKA").
      const name = rawName.trim().toUpperCase();
      if ((await findProject(client, name)).length) throw new Error(`A project named "${name}" already exists`);
      // Resolve before creating anything, so a bad MANAGERS entry creates nothing.
      const editors = defaultManagers.length ? await resolveUsers(client, defaultManagers) : [];
      const body: Record<string, unknown> = { type: "private", name };
      if (description) body.description = description;
      const { item } = await client.post("/projects", body);
      if (!item.ownerProjectManagerId) {
        // Safety net: never leave a project that other users can see.
        await client.delete(`/projects/${item.id}`).catch(() => undefined);
        throw new Error("Planka did not create the project as private; it was deleted again. Nothing was created.");
      }
      // Private projects have a single owner (the API-key user), so the MANAGERS become board editors.
      const createdBoard = board ? await createBoard(client, item.id, board, lists, { editors }) : undefined;
      return {
        id: item.id,
        name: item.name,
        type: "private",
        boardEditors: editors.map((u) => u.label),
        board: createdBoard,
      };
    }),
  );

  server.registerTool(
    "planka_create_board",
    {
      title: "Create board",
      description:
        "Create a board in a project, by default with lists Backlog / In Progress / Testing / Done. " +
        "Planka makes only the creator (the API-key user) a board member. The users from the MANAGERS config are added " +
        "as editors automatically (pass addConfiguredManagers=false to skip). Set addProjectManagers=true to also add " +
        "every manager of the project as an editor, so they can comment. This grants access, so only set it when the user asked for it.",
      inputSchema: {
        projectId: id("Project ID"),
        name: z.string().min(1).max(128),
        addProjectManagers: z
          .boolean()
          .optional()
          .describe("Add all project managers as board editors (default false)"),
        addConfiguredManagers: z
          .boolean()
          .optional()
          .describe("Add the MANAGERS from the config as board editors (default true)"),
        lists: z.array(z.string().min(1).max(128)).optional().describe("Lists to create (default Backlog, In Progress, Testing, Done; [] for none)"),
      },
      annotations: W,
    },
    safe(async ({ projectId, name, lists = DEFAULT_LISTS, addProjectManagers, addConfiguredManagers = true }) => {
      const editors = addConfiguredManagers && defaultManagers.length ? await resolveUsers(client, defaultManagers) : [];
      return createBoard(client, projectId, name, lists, { addProjectManagers, editors });
    }),
  );

  server.registerTool(
    "planka_update_project",
    {
      title: "Update project",
      description:
        "Rename a project (the new name is stored in UPPERCASE), change or clear its description, or turn " +
        "Display → \"Hide from project list and favorites\" " +
        "on or off. Hiding applies to everyone. Requires project manager rights.",
      inputSchema: {
        projectId: id("Project ID"),
        name: z.string().min(1).max(128).optional(),
        description: z.string().min(1).max(1024).nullable().optional().describe("New description; null clears it"),
        hidden: z.boolean().optional().describe('"Hide from project list and favorites"'),
      },
      annotations: W,
    },
    safe(async ({ projectId, name, description, hidden }) => {
      const body: Record<string, unknown> = {};
      if (name !== undefined) {
        name = name.trim().toUpperCase();
        const clash = (await findProject(client, name)).filter((p: any) => p.id !== projectId);
        if (clash.length) throw new Error(`A project named "${name}" already exists`);
        body.name = name;
      }
      if (description !== undefined) body.description = description;
      if (hidden !== undefined) body.isHidden = hidden;
      if (!Object.keys(body).length) throw new Error("Nothing to update: pass name, description or hidden");
      const { item } = await client.patch(`/projects/${projectId}`, body);
      return {
        id: item.id,
        name: item.name,
        description: item.description ?? null,
        isHidden: !!item.isHidden,
        type: item.ownerProjectManagerId ? "private" : "shared",
      };
    }),
  );
}
