import type { PlankaClient } from "./client.js";

/**
 * Which projects broad reads (like card search) may touch: only PRIVATE projects owned by the
 * API-key user. Shared projects, and other people's projects where the bot is merely a board member,
 * are excluded so a search never leaks their content.
 */
export interface OwnScope {
  projectIds: Set<string>;
  /** Boards of own private projects, in project order. */
  boards: { id: string; projectId: string }[];
  /** Board ID → project ID, for every board the API key can see (own or not). */
  boardProject: Map<string, string>;
  /** Number of visible projects that are not own private projects. */
  excludedProjects: number;
}

export function ownPrivateScope(projectsResp: any, meId: string): OwnScope {
  const managers = new Map<string, any>((projectsResp.included?.projectManagers ?? []).map((m: any) => [m.id, m]));
  const own = (projectsResp.items ?? []).filter((p: any) => {
    if (!p.ownerProjectManagerId) return false; // shared project
    return managers.get(p.ownerProjectManagerId)?.userId === meId;
  });
  const projectIds = new Set<string>(own.map((p: any) => p.id));
  const allBoards: any[] = projectsResp.included?.boards ?? [];
  return {
    projectIds,
    boards: allBoards.filter((b) => projectIds.has(b.projectId)).map((b) => ({ id: b.id, projectId: b.projectId })),
    boardProject: new Map(allBoards.map((b) => [b.id, b.projectId])),
    excludedProjects: (projectsResp.items ?? []).length - own.length,
  };
}

export async function loadOwnScope(client: PlankaClient): Promise<OwnScope> {
  const [me, projects] = await Promise.all([client.get("/users/me"), client.get("/projects")]);
  return ownPrivateScope(projects, me.item.id);
}
